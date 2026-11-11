import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { jsonValue, schema } from "../shared/contracts.ts";
import type {
  Json,
  Schema,
  Stage,
  Agent,
  Attempt,
  Run,
  StageVisit,
  LoopContext,
} from "../shared/contracts.ts";
import {
  resolveReference,
  resolveStageInput,
  stageOutput,
  validateReferences,
} from "../shared/bindings.ts";
import { digest } from "./files.ts";
import type { AgentBackend } from "./agent-backend.ts";
import type { RunStore } from "./run-store.ts";
import { assertStageNotBlocked } from "./validation.ts";
import { stagePrompt, stageSkipPolicy } from "./prompts.ts";
import { assertAttemptStopped } from "./process-runner.ts";
import { acceptedOutputSchema, outputArtifactName } from "./run-checkpoint.ts";
import { loopMatches } from "./loops.ts";
import { cleanupRunWorktrees } from "./run-resources.ts";

export async function executeRun(
  store: RunStore,
  id: string,
  backend: AgentBackend,
  signal: AbortSignal,
): Promise<void> {
  const unlock = store.lease(id);
  const run = store.get(id);
  try {
    store.verify(id);
    const snapshot = store.snapshot(id);
    const looping = snapshot.workflow.stages.some((stage) => stage.loop);
    if (looping) validateReferences(snapshot.workflow);
    if (snapshot.backendId !== backend.id)
      throw new Error("Pinned backend is unavailable; refusing substitution");
    const continuation = snapshot.continuation;
    const skipPolicy = stageSkipPolicy(snapshot.stageSkips);
    if (
      snapshot.stageSkips?.some(
        (skip) =>
          !snapshot.workflow.stages.some((stage) => stage.id === skip.stageId),
      ) ||
      new Set(snapshot.stageSkips?.map((skip) => skip.stageId)).size !==
        (snapshot.stageSkips?.length ?? 0)
    )
      throw new Error("Stage skip overrides do not match the pinned workflow");
    if (continuation) {
      const index = snapshot.workflow.stages.findIndex(
        (stage) => stage.id === continuation.fromStageId,
      );
      const prefix = snapshot.workflow.stages.slice(0, index);
      if (
        index < 0 ||
        continuation.checkpoints.length !== prefix.length ||
        prefix.some(
          (stage, index) =>
            continuation.checkpoints[index].stageId !== stage.id ||
            Object.keys(continuation.checkpoints[index].outputs).length !==
              stage.agents.length ||
            stage.agents.some(
              (agent) => !continuation.checkpoints[index].outputs[agent.id],
            ),
        )
      )
        throw new Error(
          "Continuation checkpoints do not match the pinned workflow",
        );
    }
    for (const unit of [
      ...Object.values(run.units),
      ...(run.visits ?? []).flatMap((visit) => Object.values(visit.units)),
    ]) {
      for (const attempt of unit.attempts)
        assertAttemptStopped(
          path.join(store.directory(id), "attempts", attempt.id),
        );
    }
    for (const stage of snapshot.workflow.stages) {
      store.readArtifactIfPresent(id, `schema-${stage.id}.json`);
      for (const agent of stage.agents)
        store.readArtifactIfPresent(id, outputArtifactName(stage.id, agent.id));
    }
    store.readArtifactIfPresent(id, "output.json");
    store.readArtifactIfPresent(id, "result.json");
    const outputs: Record<string, Json> = {};
    const handoffSchemas: Record<string, Schema> = {};
    const contexts = new Map<string, LoopContext>();
    const ranges = snapshot.workflow.stages.flatMap((stage, end) =>
      stage.loop
        ? [
            {
              stage,
              end,
              start: snapshot.workflow.stages.findIndex(
                (item) => item.id === stage.loop!.targetStageId,
              ),
            },
          ]
        : [],
    );
    const seen = new Map<string, number>();
    let visit: StageVisit | undefined;
    let loopContext: LoopContext | undefined;
    let inherited:
      NonNullable<typeof continuation>["checkpoints"][number] | undefined;
    let cursor = 0;
    signal.throwIfAborted();
    if (looping) {
      run.visits ??= [];
      run.units = {};
    }
    run.status = "running";
    delete run.error;
    store.save(run);
    for (let stageIndex = 0; stageIndex < snapshot.workflow.stages.length;) {
      const stage = snapshot.workflow.stages[stageIndex];
      signal.throwIfAborted();
      const iteration = (seen.get(stage.id) ?? 0) + 1;
      seen.set(stage.id, iteration);
      inherited =
        iteration === 1
          ? continuation?.checkpoints.find((item) => item.stageId === stage.id)
          : undefined;
      const range = ranges.find(
        ({ start, end }) => start <= stageIndex && stageIndex <= end,
      );
      if (range && !contexts.has(range.stage.id))
        contexts.set(range.stage.id, {
          stageId: range.stage.id,
          iteration: 1,
          maxIterations: range.stage.loop!.maxIterations,
          feedback: null,
        });
      loopContext =
        inherited?.loopContext ??
        (range ? contexts.get(range.stage.id) : undefined);
      if (looping) {
        const visitId = `visit-${++cursor}`;
        visit = run.visits!.find((item) => item.id === visitId);
        if (
          visit &&
          (visit.stageId !== stage.id || visit.iteration !== iteration)
        )
          throw new Error(
            "Persisted loop path does not match accepted routing",
          );
        if (!visit) {
          visit = {
            id: visitId,
            stageId: stage.id,
            iteration,
            units: {},
            ...(loopContext ? { loopContext } : {}),
          };
          run.visits!.push(visit);
        }
        run.currentVisit = visitId;
      }
      run.currentStage = stage.id;
      store.save(run);
      const stageInput = resolveStageInput(
        snapshot.workflow,
        stage,
        snapshot.input,
        outputs,
        loopContext,
      );
      if (visit)
        store.artifact(id, `input-${visit.id}.json`, {
          stageInput,
          handoffs: { ...outputs },
          loopContext: loopContext ?? null,
        });
      const contract = await expandedSchema(stage);
      const settled = await Promise.allSettled(
        stage.agents.map((agent) =>
          unit(stage, agent, contract, stageInput, outputs),
        ),
      );
      const failures = settled.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          `${stage.name}: ${failures.length} agent(s) failed`,
        );
      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        if (result.status === "fulfilled") {
          const key = `${stage.id}/${stage.agents[index].id}`;
          outputs[key] = result.value;
          handoffSchemas[key] = contract;
        }
      }
      assertStageNotBlocked(stage, outputs);
      if (stage.loop && visit) {
        const skipped = snapshot.stageSkips?.some(
          (item) => item.stageId === stage.id,
        );
        const result = skipped ? undefined : loopMatches(stage, outputs);
        const context = contexts.get(stage.id)!;
        const repeat = result?.matches === true;
        if (inherited && repeat)
          throw new Error(
            "An inherited loop has not exited. Rerun from its closing stage or an earlier stage.",
          );
        const feedback = repeat
          ? stage.expectedOutput !== undefined
            ? stageOutput(stage, outputs)
            : Object.fromEntries(
                Object.entries(stage.loop.feedback).map(([name, ref]) => [
                  name,
                  resolveReference(
                    ref,
                    snapshot.input,
                    outputs,
                    undefined,
                    loopContext,
                  ),
                ]),
              )
          : undefined;
        const route = {
          kind: skipped
            ? ("skipped" as const)
            : !repeat
              ? ("continue" as const)
              : context.iteration >= stage.loop.maxIterations
                ? ("limit" as const)
                : ("repeat" as const),
          ...(result ? { value: result.value } : {}),
          ...(repeat
            ? { targetStageId: stage.loop.targetStageId, feedback }
            : {}),
        };
        store.artifact(id, `route-${visit.id}.json`, route);
        visit.route = route;
        store.save(run);
        if (route.kind === "limit")
          throw new Error(
            `Loop at "${stage.name}" reached its maximum of ${stage.loop.maxIterations} total passes while the condition still matched. Resolve the latest feedback and rerun; Resume does not reset the limit.`,
          );
        if (route.kind === "repeat") {
          contexts.set(stage.id, {
            ...context,
            iteration: context.iteration + 1,
            feedback: feedback!,
          });
          const target = snapshot.workflow.stages.findIndex(
            (item) => item.id === stage.loop!.targetStageId,
          );
          for (const stale of snapshot.workflow.stages.slice(target)) {
            delete run.units[`@schema/${stale.id}`];
            for (const agent of stale.agents) {
              const key = `${stale.id}/${agent.id}`;
              delete outputs[key];
              delete handoffSchemas[key];
              delete run.units[key];
            }
          }
          stageIndex = target;
          continue;
        }
      }
      stageIndex++;
    }
    if (looping && cursor !== run.visits!.length)
      throw new Error(
        "Persisted loop history contains an unexpected future visit",
      );
    const finalStage = snapshot.workflow.stages.at(-1)!;
    const finalOutputs = finalStage.agents.map(
      (agent) => outputs[`${finalStage.id}/${agent.id}`],
    );
    const defaultResult =
      snapshot.workflow.stages.length === 1 &&
      !finalStage.loop &&
      finalOutputs.length === 1
        ? finalOutputs[0]
        : finalOutputs;
    const result = snapshot.workflow.result
      ? resolveReference(snapshot.workflow.result, snapshot.input, outputs)
      : defaultResult;
    store.artifact(id, "output.json", finalOutputs);
    store.artifact(id, "result.json", result);
    run.result = result;
    run.status = "completed";
    delete run.error;
    store.save(run);

    async function expandedSchema(stage: Stage): Promise<Schema> {
      const name = `schema-${stage.id}.json`;
      const key = `@schema/${stage.id}`;
      const record = recordFor(key, stage, "schema", `${stage.name} contract`);
      if (continuation && inherited)
        record.reusedFrom = continuation.sourceRunId;
      const saved = store.readArtifactIfPresent(id, name);
      if (saved !== undefined) {
        const contract = schema.parse(saved);
        completeRecoveredUnit(record);
        return contract;
      }
      if (inherited) {
        store.artifact(id, name, inherited.contract);
        completeRecoveredUnit(record);
        return inherited.contract;
      }
      if (snapshot.stageSkips?.some((skip) => skip.stageId === stage.id)) {
        const contract = {
          type: "object",
          properties: {
            status: { const: "skipped" },
            summary: { type: "string" },
            ownerOverride: { type: "object" },
          },
          required: ["status", "summary", "ownerOverride"],
        };
        store.artifact(id, name, contract);
        completeRecoveredUnit(record);
        return contract;
      }
      const attempt: Attempt = {
        id: `schema-${stage.id}-${randomUUID()}`,
        status: "running",
      };
      record.attempts.push(attempt);
      record.status = "running";
      store.save(run);
      const directory = path.join(store.directory(id), "attempts", attempt.id);
      fs.mkdirSync(directory, { recursive: true });
      try {
        const output = await backend.execute(
          {
            directory,
            purpose: "schema",
            allowAllTools: snapshot.allowAllTools ?? false,
            allowedFolders: snapshot.allowedFolders ?? [],
            paths: snapshot.paths,
            schema: { type: "object" },
            input: jsonValue.parse(stage.outputSchema),
            prompt: [
              stage.expectedOutput === undefined
                ? `Expand this starting JSON Schema into the output schema for stage "${stage.name}".`
                : `Create the smallest JSON Schema matching the expected output for stage "${stage.name}". The user describes the result in plain language; do not add audit metadata, summaries, or extra required fields unless requested. General procedural instructions do not imply additional output fields.`,
              'Every task result must be a JSON object with a required top-level "status" property: {"type":"string","enum":["blocked","failed","completed"]}. This mandatory task status is the exception to the instruction against extra fields. "completed" means the requested task was accomplished, "blocked" means a missing prerequisite or external dependency prevented completion, and "failed" means the task was attempted but could not be completed. Do not equate finishing an agent session with completing the task. Preserve requested object fields alongside status; for scalar or array results, put the requested value in a required "result" property alongside status. On blocked or failed outcomes, allow unavailable success data to be omitted and allow a summary explaining the issue. Keep domain-specific verdicts in separate fields rather than using other status values.',
              "Use the agent instructions below as context, not as tasks to execute. Describe the data these agents are actually asked to return. Do not invent provider restrictions, mandatory reports, or action prerequisites that their instructions do not require. For parallel agents, the shared schema must support each role's output independently.",
              "Retain the authored $schema dialect; if absent, use JSON Schema Draft-07 (http://json-schema.org/draft-07/schema#). Return the schema itself as a JSON object, not a wrapper.",
              stage.expectedOutput === undefined
                ? `## Starting schema\n${JSON.stringify(stage.outputSchema, null, 2)}`
                : `## Expected output\n${stage.expectedOutput}`,
              ...(stage.loop
                ? [
                    `## Required routing output\n${JSON.stringify(stage.loop.condition)}\n${stage.loop.repeatWhen ? `Repeat when: ${stage.loop.repeatWhen}\n` : ""}The selected agent must return this configured field with the comparison value's type. Routing is engine-controlled; do not omit or rename it.`,
                  ]
                : []),
              `## Agent instructions\n${JSON.stringify(
                stage.agents.map((agent) => ({
                  name: agent.name,
                  instructions: agent.instructions,
                })),
                null,
                2,
              )}`,
              skipPolicy,
            ].join("\n\n"),
          },
          signal,
        );
        signal.throwIfAborted();
        const expanded = schema.parse(output);
        store.artifact(id, name, expanded);
        record.status = "completed";
        attempt.status = "completed";
        store.save(run);
        return expanded;
      } catch (error) {
        record.status = signal.aborted ? "cancelled" : "blocked";
        attempt.status = record.status;
        attempt.error = error instanceof Error ? error.message : String(error);
        store.save(run);
        throw error;
      }
    }
    function recordFor(
      key: string,
      stage: Stage,
      agentId: string,
      name: string,
    ): Run["units"][string] {
      const records = visit?.units ?? run.units;
      const record = (records[key] ??= {
        stageId: stage.id,
        agentId,
        name,
        status: "queued",
        attempts: [],
        ...(visit ? { visitId: visit.id } : {}),
      });
      run.units[key] = record;
      return record;
    }
    function completeRecoveredUnit(
      record: Run["units"][string],
      output?: Json,
    ): void {
      record.status = snapshot.stageSkips?.some(
        (skip) => skip.stageId === record.stageId,
      )
        ? "skipped"
        : "completed";
      const attempt = record.attempts.at(-1);
      if (attempt?.status === "running") {
        attempt.status = "completed";
        delete attempt.error;
        if (output !== undefined) attempt.output = output;
      }
      store.save(run);
    }
    async function unit(
      stage: Stage,
      agent: Agent,
      contract: Schema,
      stageInput: Json,
      handoffs: Record<string, Json>,
    ): Promise<Json> {
      const key = `${stage.id}/${agent.id}`;
      const artifactName = outputArtifactName(stage.id, agent.id, visit?.id);
      const inputDigest = digest({
        input: snapshot.input,
        stageInput,
        handoffs,
        ...(loopContext ? { loopContext } : {}),
      });
      const record = recordFor(key, stage, agent.id, agent.name);
      let accepted = store.readArtifactIfPresent(id, artifactName);
      const inheritedOutput = inherited?.outputs[agent.id];
      if (continuation && inheritedOutput)
        record.reusedFrom = continuation.sourceRunId;
      if (accepted === undefined && inheritedOutput && continuation) {
        if (
          inheritedOutput.runId !== continuation.sourceRunId ||
          inheritedOutput.inputDigest !== inputDigest ||
          inheritedOutput.stageId !== stage.id ||
          inheritedOutput.agentId !== agent.id
        )
          throw new Error("Inherited output identity mismatch");
        accepted = {
          ...inheritedOutput,
          runId: id,
          ...(visit ? { visitId: visit.id } : {}),
        };
        store.artifact(id, artifactName, accepted);
      }
      if (accepted !== undefined) {
        const saved = acceptedOutputSchema.parse(accepted);
        if (
          saved.runId !== id ||
          saved.inputDigest !== inputDigest ||
          saved.stageId !== stage.id ||
          saved.agentId !== agent.id ||
          saved.visitId !== visit?.id
        )
          throw new Error("Accepted output identity mismatch");
        record.output = saved.output;
        completeRecoveredUnit(record, saved.output);
        return saved.output;
      }
      const skip = snapshot.stageSkips?.find(
        (item) => item.stageId === stage.id,
      );
      if (skip) {
        const output: Json = {
          status: "skipped",
          summary: `${stage.name} skipped by owner: ${skip.reason}`,
          ownerOverride: { ...skip },
        };
        store.artifact(id, artifactName, {
          runId: id,
          inputDigest,
          stageId: stage.id,
          agentId: agent.id,
          output,
          ...(visit ? { visitId: visit.id } : {}),
        });
        record.output = output;
        completeRecoveredUnit(record, output);
        return output;
      }
      const previousVisits =
        run.visits?.filter(
          (item) => item.stageId === stage.id && item.id !== visit?.id,
        ) ?? [];
      const previousOutput = previousVisits.at(-1)?.units[key]?.output;
      const attempt: Attempt = {
        id: `${stage.id}-${agent.id}-${randomUUID()}`,
        status: "running",
      };
      record.attempts.push(attempt);
      record.status = "running";
      store.save(run);
      const directory = path.join(store.directory(id), "attempts", attempt.id);
      fs.mkdirSync(directory, { recursive: true });
      try {
        const output = await backend.execute(
          {
            directory,
            schema: contract,
            purpose: "stage",
            allowAllTools: snapshot.allowAllTools ?? false,
            allowedFolders:
              agent.allowedFolders ?? snapshot.allowedFolders ?? [],
            paths: snapshot.paths,
            input: stageInput,
            model: agent.model,
            prompt: [
              `## Workflow run\n${JSON.stringify({ runId: id, stages: snapshot.workflow.stages.map((item) => item.id) }, null, 2)}`,
              continuation ? continuationPrompt(continuation) : "",
              stagePrompt(
                stage,
                agent,
                snapshot.skills,
                snapshot.input,
                stageInput,
                handoffs,
                handoffSchemas,
              ),
              continuation
                ? `## Historical attempt of this agent (not a current handoff)\n${JSON.stringify(continuation.history[key] ?? null, null, 2)}`
                : "",
              skipPolicy,
              ...(loopContext
                ? [
                    `## Loop context\n${JSON.stringify(loopContext, null, 2)}`,
                    "This is a stage visit in a bounded loop. Execute the stage's instructions using the supplied feedback. Earlier-pass feedback is historical context, not a current result. The engine evaluates routing.",
                  ]
                : []),
              ...(previousVisits.length
                ? [
                    `## Historical visits of this agent (not a current handoff)\n${JSON.stringify(
                      {
                        previousOutput: previousOutput ?? null,
                        attemptDirectories: previousVisits.flatMap(
                          (item) =>
                            item.units[key]?.attempts.map((past) =>
                              path.join(
                                store.directory(id),
                                "attempts",
                                past.id,
                              ),
                            ) ?? [],
                        ),
                      },
                      null,
                      2,
                    )}`,
                  ]
                : []),
              ...(stage.loop
                ? [
                    `## Routing field\n${JSON.stringify(stage.loop.condition)}\n${stage.loop.repeatWhen ? `Repeat when: ${stage.loop.repeatWhen}\n` : ""}Return this field according to your task's actual criteria. Do not select a destination or fabricate a successful condition to escape the loop.`,
                  ]
                : []),
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          signal,
        );
        signal.throwIfAborted();
        store.artifact(id, artifactName, {
          runId: id,
          inputDigest,
          stageId: stage.id,
          agentId: agent.id,
          output,
          ...(visit ? { visitId: visit.id } : {}),
        });
        record.output = output;
        record.status = "completed";
        Object.assign(attempt, { status: "completed", output });
        store.save(run);
        return output;
      } catch (error) {
        record.status = signal.aborted ? "cancelled" : "blocked";
        const text = error instanceof Error ? error.message : String(error);
        Object.assign(attempt, { status: record.status, error: text });
        store.save(run);
        throw error;
      }
    }
    function continuationPrompt(
      continuation: NonNullable<typeof snapshot.continuation>,
    ): string {
      return [
        `This is continuation run ${id}, rerunning from stage "${continuation.fromStageId}" of source run ${continuation.sourceRunId}.`,
        continuation.checkpoints.length
          ? "Earlier stages are reused, not rerun. Their accepted outputs are supplied as handoffs."
          : "No earlier stages are reused.",
        "Execute the restarted stages according to their own instructions. Historical attempts are context, not accepted results for this run. The stage instructions determine how to handle prior side effects.",
        "The pinned workflow, inputs, skills, tools, and folder permissions still apply.",
      ].join("\n\n");
    }
  } catch (error) {
    run.status = signal.aborted ? "cancelled" : "blocked";
    run.error = describeError(error);
    store.save(run);
  } finally {
    try {
      cleanupRunWorktrees(store, id);
    } catch (error) {
      if (run.status !== "cancelled") run.status = "blocked";
      run.error = [
        run.error,
        `Workspace cleanup failed: ${describeError(error)}`,
      ]
        .filter(Boolean)
        .join("; ");
      store.save(run);
    } finally {
      unlock();
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map(describeError).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}
