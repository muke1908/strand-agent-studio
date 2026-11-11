import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Catalog } from "./catalog.ts";
import type { AgentBackend } from "./agent-backend.ts";
import { claim } from "./files.ts";
import { digest } from "./files.ts";
import { compareQueueOrder, createRunStore } from "./run-store.ts";
import { executeRun } from "./run-engine.ts";
import { validateJson } from "./validation.ts";
import {
  resolveAllowedFolders,
  resolveWorkflowFolders,
} from "./allowed-folders.ts";
import { stageSkipSchema } from "../shared/contracts.ts";
import type {
  Json,
  QueueState,
  Run,
  RunSummary,
  StageSkip,
} from "../shared/contracts.ts";
import { isAction } from "../shared/workflow-kind.ts";
import { checkpointPrefix } from "./run-checkpoint.ts";
import { assertAttemptStopped } from "./process-runner.ts";
import { createResultSummaries } from "./result-summary.ts";
import { createWatchActionCompiler } from "./watch-action-compiler.ts";
import { createInputSchemaCompiler } from "./input-schema-compiler.ts";
import { createWatchScheduleCompiler } from "./watch-schedule-compiler.ts";
import { cleanupRunWorktrees } from "./run-resources.ts";

export class WorkflowBusyError extends Error {
  readonly status = 409;
  readonly runId: string;
  constructor(runId: string) {
    super(
      `Run ${runId} is using this workflow. Stop or finish it before starting another run.`,
    );
    this.runId = runId;
  }
}

export function createRunHost(
  root: string,
  catalog: Catalog,
  backend: AgentBackend,
) {
  const store = createRunStore(root);
  const summaries = createResultSummaries(store, backend);
  const actionCompiler = createWatchActionCompiler(root, catalog, backend);
  const inputCompiler = createInputSchemaCompiler(root, backend);
  const scheduleCompiler = createWatchScheduleCompiler(root, backend);
  const active = new Map<
    string,
    { abort: AbortController; promise: Promise<void>; queued: boolean }
  >();
  const queue = new Map<string, Run>();
  const errors: string[] = [];
  type Snapshot = ReturnType<typeof store.snapshot>;
  function busy(workflowId: string, excludeId?: string): Run | undefined {
    return store
      .list()
      .find(
        (run) =>
          run.id !== excludeId &&
          run.workflowId === workflowId &&
          (["queued", "running"].includes(run.status) || active.has(run.id)),
      );
  }
  function assertWorkflowIdle(
    workflowId: string,
    excludeId?: string,
    required = false,
  ): void {
    if (
      !required &&
      !catalog
        .watches()
        .some(
          ({ value }) =>
            value.action &&
            (value.workflowId === workflowId ||
              value.action.workflowId === workflowId),
        )
    )
      return;
    const other = busy(workflowId, excludeId);
    if (other) throw new WorkflowBusyError(other.id);
  }
  let closing = false;
  function deleteHistory(runs: Run[]): number {
    if (
      runs.some(
        (run) =>
          active.has(run.id) ||
          queue.has(run.id) ||
          ["queued", "running"].includes(run.status),
      )
    )
      throw Object.assign(
        new Error("Stop or finish active runs before deleting their history."),
        { status: 409 },
      );
    for (const run of runs) store.removeFromHistory(run.id);
    return runs.length;
  }
  function pump(): void {
    if (closing || active.size >= 2) return;
    const serialActive = [...active.values()].some((item) => item.queued);
    const next = [...queue.values()].find(
      (run) => !run.queued || !serialActive,
    );
    if (!next) return;
    const id = next.id;
    queue.delete(id);
    const abort = new AbortController();
    const promise = executeRun(store, id, backend, abort.signal)
      .then(() => {
        if (closing) return;
        try {
          summaries.generate(id);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          console.error("Result summary could not be started:", error);
        }
      })
      .catch((error) => {
        errors.push(error instanceof Error ? error.message : String(error));
        console.error("Run execution failed:", error);
      })
      .finally(() => {
        active.delete(id);
        pump();
      });
    active.set(id, { abort, promise, queued: next.queued ?? false });
    pump();
  }
  for (const run of store.list().sort(compareQueueOrder)) {
    if (run.status === "running") {
      const release = store.lease(run.id);
      try {
        run.status = "blocked";
        run.error =
          "Host restarted. Verify the interrupted attempt and resume.";
        store.save(run);
      } finally {
        release();
      }
    } else if (run.status === "queued") queue.set(run.id, run);
    if (!["running", "queued"].includes(run.status)) {
      try {
        cleanupRunWorktrees(store, run.id);
      } catch (error) {
        const message = `Workspace recovery for ${run.id} failed: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        console.error(message);
        run.status = "blocked";
        run.error = [run.error, message].filter(Boolean).join("; ");
        store.save(run);
      }
    }
  }
  queueMicrotask(pump);
  return {
    store,
    summaries,
    errors,
    busy,
    deleteRunHistory: (id: string) => deleteHistory([store.get(id)]),
    deleteWorkflowHistory: (workflowId: string, kind?: RunSummary["kind"]) =>
      deleteHistory(
        store
          .history()
          .filter(
            (run) =>
              run.workflowId === workflowId &&
              (kind === undefined ||
                isAction(store.snapshot(run.id).workflow) ===
                  (kind === "action")),
          ),
      ),
    queueState(): QueueState {
      const runs = store
        .history()
        .filter((run) => run.queued)
        .sort((a, b) => compareQueueOrder(b, a));
      return {
        runs: runs.slice(0, 30),
        pending: runs.filter((run) => run.status === "queued").length,
        running: runs.filter((run) => run.status === "running").length,
      };
    },
    compileWatchAction: actionCompiler.compile,
    compileInputSchema: inputCompiler.compile,
    compileWatchSchedule: scheduleCompiler.compile,
    launch(
      workflowId: string,
      input: Json,
      requestId: string,
      trigger?: Run["trigger"],
      allowAllTools = false,
      idleWorkflowIds: string[] = [],
    ): Run {
      if (closing)
        throw Object.assign(new Error("Host is shutting down"), {
          status: 503,
        });
      const release = claim(path.join(root, "admission"));
      try {
        const existing = store
          .list()
          .find((run) => run.requestId === requestId);
        if (existing) {
          const snapshot = store.snapshot(existing.id);
          if (
            existing.continuation ||
            existing.workflowId !== workflowId ||
            digest(snapshot.input) !== digest(input) ||
            (snapshot.allowAllTools ?? false) !== allowAllTools ||
            digest(existing.trigger ?? null) !== digest(trigger ?? null)
          )
            throw Object.assign(
              new Error("Submission identity was reused for different input"),
              { status: 409 },
            );
          return existing;
        }
        assertWorkflowIdle(workflowId);
        for (const id of idleWorkflowIds)
          assertWorkflowIdle(id, undefined, true);
        const diagnostic = backend.diagnostics();
        if (!diagnostic.available)
          throw Object.assign(new Error(diagnostic.reason), { status: 503 });
        const workflow = catalog.runtimeWorkflow(
          catalog.workflow(workflowId).value,
        );
        const paths = catalog.config.paths;
        const shared = Object.keys(paths).length
          ? {
              paths,
              allowedFolders: resolveAllowedFolders(Object.values(paths)),
            }
          : undefined;
        if (!trigger || typeof input !== "string")
          validateJson(workflow.inputSchema, input);
        const skills = catalog.skills().map((item) => item.value);
        const run = store.create(
          workflow,
          skills,
          input,
          requestId,
          backend.id,
          trigger,
          allowAllTools,
          shared,
        );
        queue.set(run.id, run);
        queueMicrotask(pump);
        return run;
      } finally {
        release();
      }
    },
    rerun(
      id: string,
      fromStageId: string,
      requestId: string,
      skip?: Omit<StageSkip, "stageId" | "at">,
      latestInstructions = false,
    ): Run {
      if (closing)
        throw Object.assign(new Error("Host is shutting down"), {
          status: 503,
        });
      const release = claim(path.join(root, "admission"));
      try {
        const override = skip
          ? stageSkipSchema.parse({
              ...skip,
              stageId: fromStageId,
              at: new Date().toISOString(),
            })
          : undefined;
        const existing = store
          .list()
          .find((run) => run.requestId === requestId);
        if (existing) {
          if (
            existing.continuation?.sourceRunId !== id ||
            existing.continuation.fromStageId !== fromStageId ||
            (store.snapshot(existing.id).continuation?.latestInstructions ??
              false) !== latestInstructions ||
            existing.stageSkips?.find((item) => item.stageId === fromStageId)
              ?.reason !== override?.reason ||
            existing.stageSkips?.find((item) => item.stageId === fromStageId)
              ?.allowPublication !== override?.allowPublication
          )
            throw Object.assign(
              new Error("Submission identity was reused for a different rerun"),
              { status: 409 },
            );
          return existing;
        }
        const source = store.get(id);
        assertWorkflowIdle(source.workflowId);
        if (
          override &&
          (!["blocked", "cancelled"].includes(source.status) ||
            source.currentStage !== fromStageId)
        )
          throw Object.assign(
            new Error(
              "Only the current stage of a blocked or cancelled run can be skipped",
            ),
            { status: 409 },
          );
        if (active.has(id) || ["queued", "running"].includes(source.status))
          throw Object.assign(
            new Error("Stop or finish the source run before rerunning a stage"),
            { status: 409 },
          );
        const diagnostic = backend.diagnostics();
        if (!diagnostic.available)
          throw Object.assign(new Error(diagnostic.reason), { status: 503 });
        const unlock = store.lease(id);
        try {
          store.verify(id);
          const snapshot = store.snapshot(id);
          let workflow = snapshot.workflow;
          const current =
            workflow.stages[0]?.id === fromStageId
              ? catalog
                  .workflows()
                  .find(({ value }) => value.id === source.workflowId)
              : undefined;
          if (
            current &&
            (!source.trigger || typeof snapshot.input !== "string")
          ) {
            try {
              validateJson(current.value.inputSchema, snapshot.input);
            } catch (error) {
              if (
                !(error instanceof Error) ||
                !("status" in error) ||
                error.status !== 400
              )
                throw error;
              throw Object.assign(
                new Error(
                  `The saved inputs no longer satisfy this workflow's input schema. Launch a new run with corrected inputs instead of retrying the same values. ${error.message}`,
                  { cause: error },
                ),
                { status: 400 },
              );
            }
          }
          if (latestInstructions) {
            const current = catalog.runtimeWorkflow(
              catalog.workflow(source.workflowId).value,
            );
            const structure = (value: typeof workflow) => ({
              ...value,
              queued: false,
              stages: value.stages.map((stage) => ({
                ...stage,
                instructions: "",
                agents: stage.agents.map((agent) => ({
                  ...agent,
                  instructions: "",
                })),
              })),
            });
            if (!isDeepStrictEqual(structure(current), structure(workflow)))
              throw Object.assign(
                new Error(
                  "Workflow structure or permissions changed. Launch a new run.",
                ),
                { status: 409 },
              );
            if (!isDeepStrictEqual(snapshot.paths ?? {}, catalog.config.paths))
              throw Object.assign(
                new Error(
                  "Configured paths changed. Launch a new run instead of redirecting a continuation.",
                ),
                { status: 409 },
              );
            workflow = current;
          }
          if (snapshot.backendId !== backend.id)
            throw Object.assign(
              new Error("Pinned backend is unavailable; refusing substitution"),
              { status: 409 },
            );
          if (
            digest(resolveWorkflowFolders(snapshot.workflow)) !==
              digest(snapshot.workflow) ||
            (snapshot.allowedFolders &&
              digest(resolveAllowedFolders(snapshot.allowedFolders)) !==
                digest([...new Set(snapshot.allowedFolders)].sort()))
          )
            throw Object.assign(
              new Error(
                "Pinned folder identities changed; verify access before rerunning",
              ),
              { status: 409 },
            );
          for (const unit of [
            ...Object.values(source.units),
            ...(source.visits ?? []).flatMap((visit) =>
              Object.values(visit.units),
            ),
          ])
            for (const attempt of unit.attempts) {
              try {
                assertAttemptStopped(
                  path.join(store.directory(id), "attempts", attempt.id),
                  true,
                );
              } catch (error) {
                throw Object.assign(
                  new Error(
                    `Cannot restart while a previous attempt is active or unverifiable: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error },
                  ),
                  { status: 409 },
                );
              }
            }
          const checkpoints = checkpointPrefix(store, id, fromStageId);
          cleanupRunWorktrees(store, id);
          const index = snapshot.workflow.stages.findIndex(
            (stage) => stage.id === fromStageId,
          );
          const prefixIds = new Set(
            snapshot.workflow.stages.slice(0, index).map((stage) => stage.id),
          );
          const stageSkips = [
            ...(snapshot.stageSkips ?? []).filter((item) =>
              prefixIds.has(item.stageId),
            ),
            ...(override ? [override] : []),
          ];
          const continuation: NonNullable<Snapshot["continuation"]> = {
            sourceRunId: id,
            fromStageId,
            ...(latestInstructions ? { latestInstructions: true } : {}),
            checkpoints,
            history: Object.fromEntries(
              Object.entries(
                Object.fromEntries([
                  ...(source.visits ?? []).flatMap((visit) =>
                    Object.entries(visit.units),
                  ),
                  ...Object.entries(source.units),
                ]),
              ).map(([key, unit]) => [
                key,
                {
                  ...(unit.output === undefined ? {} : { output: unit.output }),
                  ...(unit.attempts.at(-1)?.error
                    ? { error: unit.attempts.at(-1)!.error }
                    : {}),
                  attemptDirectories: [
                    ...new Map(
                      [
                        ...(source.visits ?? []).flatMap(
                          (visit) => visit.units[key]?.attempts ?? [],
                        ),
                        ...unit.attempts,
                      ].map((attempt) => [attempt.id, attempt]),
                    ).values(),
                  ].map((attempt) =>
                    path.join(store.directory(id), "attempts", attempt.id),
                  ),
                },
              ]),
            ),
          };
          const run = store.create(
            workflow,
            snapshot.skills,
            snapshot.input,
            requestId,
            snapshot.backendId,
            source.trigger,
            snapshot.allowAllTools ?? false,
            {
              continuation,
              ...(stageSkips.length ? { stageSkips } : {}),
              ...(snapshot.allowedFolders
                ? { allowedFolders: snapshot.allowedFolders }
                : {}),
              ...(snapshot.paths ? { paths: snapshot.paths } : {}),
            },
          );
          queue.set(run.id, run);
          queueMicrotask(pump);
          return run;
        } finally {
          unlock();
        }
      } finally {
        release();
      }
    },
    async rerunStage(
      id: string,
      fromStageId: string,
      requestId: string,
      latestInstructions = true,
    ): Promise<Run> {
      if (
        !closing &&
        !store.list().some((run) => run.requestId === requestId)
      ) {
        checkpointPrefix(store, id, fromStageId);
        const execution = active.get(id)?.promise;
        if (execution || queue.has(id)) {
          this.stop(id);
          await execution;
        }
      }
      return this.rerun(
        id,
        fromStageId,
        requestId,
        undefined,
        latestInstructions,
      );
    },
    resume(id: string): Run {
      if (closing)
        throw Object.assign(new Error("Host is shutting down"), {
          status: 503,
        });
      const diagnostic = backend.diagnostics();
      if (!diagnostic.available)
        throw Object.assign(new Error(diagnostic.reason), { status: 503 });
      const run = store.get(id);
      if (
        active.has(id) ||
        run.status === "completed" ||
        run.status === "queued"
      )
        throw Object.assign(
          new Error("Run cannot be resumed in its current state"),
          { status: 409 },
        );
      const admission = claim(path.join(root, "admission"));
      try {
        store.verify(id);
        assertWorkflowIdle(run.workflowId, id);
        const release = store.lease(id);
        try {
          delete run.error;
          store.enqueue(run);
          queue.set(id, run);
        } finally {
          release();
        }
      } finally {
        admission();
      }
      queueMicrotask(pump);
      return run;
    },
    stop(id: string): Run {
      const run = store.get(id);
      if (active.has(id))
        active.get(id)!.abort.abort(new Error("Run cancelled"));
      else if (queue.delete(id)) {
        run.status = "cancelled";
        store.save(run);
      } else
        throw Object.assign(new Error("Run is not active"), { status: 409 });
      return run;
    },
    async close(): Promise<void> {
      closing = true;
      await Promise.all([
        actionCompiler.close(),
        inputCompiler.close(),
        scheduleCompiler.close(),
      ]);
      for (const item of active.values())
        item.abort.abort(new Error("Host shutting down"));
      await Promise.all([...active.values()].map((item) => item.promise));
      await summaries.close();
    },
  };
}
export type RunHost = ReturnType<typeof createRunHost>;
