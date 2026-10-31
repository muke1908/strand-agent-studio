import path from "node:path";
import type { Catalog } from "./catalog.ts";
import type { AgentBackend } from "./agent-backend.ts";
import { claim } from "./files.ts";
import { digest } from "./files.ts";
import { createRunStore } from "./run-store.ts";
import { executeRun } from "./run-engine.ts";
import { validateJson } from "./validation.ts";
import { resolveWorkflowFolders } from "./allowed-folders.ts";
import type { Json, Run } from "../shared/contracts.ts";

export function createRunHost(
  root: string,
  catalog: Catalog,
  backend: AgentBackend,
) {
  const store = createRunStore(root);
  const active = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();
  const queue = new Set<string>();
  const errors: string[] = [];
  let closing = false;
  function pump(): void {
    if (closing || active.size >= 2) return;
    const id = queue.values().next().value;
    if (!id) return;
    queue.delete(id);
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(30 * 60 * 1000),
    ]);
    const promise = executeRun(store, id, backend, signal)
      .catch((error) => {
        errors.push(error instanceof Error ? error.message : String(error));
        console.error("Run execution failed:", error);
      })
      .finally(() => {
        active.delete(id);
        pump();
      });
    active.set(id, { abort, promise });
    pump();
  }
  for (const run of store.list()) {
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
    } else if (run.status === "queued") queue.add(run.id);
  }
  queueMicrotask(pump);
  return {
    store,
    errors,
    launch(
      workflowId: string,
      input: Json,
      requestId: string,
      trigger?: Run["trigger"],
      allowAllTools = false,
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
        const diagnostic = backend.diagnostics();
        if (!diagnostic.available)
          throw Object.assign(new Error(diagnostic.reason), { status: 503 });
        const workflow = resolveWorkflowFolders(
          catalog.workflow(workflowId).value,
        );
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
        );
        queue.add(run.id);
        queueMicrotask(pump);
        return run;
      } finally {
        release();
      }
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
      store.verify(id);
      const release = store.lease(id);
      try {
        run.status = "queued";
        delete run.error;
        store.save(run);
        queue.add(id);
      } finally {
        release();
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
      for (const item of active.values())
        item.abort.abort(new Error("Host shutting down"));
      await Promise.all([...active.values()].map((item) => item.promise));
    },
  };
}
export type RunHost = ReturnType<typeof createRunHost>;
