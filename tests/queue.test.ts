import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AgentBackend } from "../server/agent-backend.ts";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { createRunStore } from "../server/run-store.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";

function serialWorkflow(id: string) {
  const definition = workflow(id);
  definition.queued = true;
  definition.stages = [definition.stages[0]];
  definition.stages[0].agents = [definition.stages[0].agents[0]];
  return definition;
}

function controlledBackend(contexts: string[]) {
  const gates = new Map(
    contexts.map((context) => [
      context,
      {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      },
    ]),
  );
  const started: string[] = [];
  const backend: AgentBackend = {
    id: "queue-fixture",
    diagnostics: () => ({ available: true }),
    async execute(request, signal) {
      signal.throwIfAborted();
      if (request.purpose === "schema") return request.input;
      if (request.purpose === "summary")
        return {
          lines: ["Queue fixture completed.", "No external actions ran."],
        };
      assert(request.input && typeof request.input === "object");
      assert(!Array.isArray(request.input));
      const context = request.input.context;
      assert(typeof context === "string");
      const gate = gates.get(context);
      assert(gate);
      started.push(context);
      gate.started.resolve();
      await gate.release.promise;
      signal.throwIfAborted();
      return { summary: context };
    },
  };
  return { backend, gates, started };
}

test("serial workflows share a FIFO lane while unchecked runs overlap and cancellation waits for cleanup", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const firstDefinition = serialWorkflow("first");
  const secondDefinition = serialWorkflow("second");
  const parallelDefinition = serialWorkflow("parallel");
  delete parallelDefinition.queued;
  catalog.saveWorkflow(firstDefinition);
  const secondSaved = catalog.saveWorkflow(secondDefinition);
  catalog.saveWorkflow(parallelDefinition);
  const { backend, gates, started } = controlledBackend([
    "first",
    "second",
    "cancelled",
    "parallel",
  ]);
  const host = createRunHost(root, catalog, backend);
  try {
    const first = host.launch("first", { context: "first" }, "first");
    const second = host.launch("second", { context: "second" }, "second");
    const cancelled = host.launch(
      "first",
      { context: "cancelled" },
      "cancelled",
    );
    const parallel = host.launch(
      "parallel",
      { context: "parallel" },
      "parallel",
    );
    await Promise.all([
      gates.get("first")!.started.promise,
      gates.get("parallel")!.started.promise,
    ]);
    assert.deepEqual(started, ["first", "parallel"]);
    assert.equal(host.store.get(second.id).status, "queued");
    assert.equal(host.queueState().pending, 2);
    assert.equal(host.queueState().running, 1);
    assert.equal(host.stop(cancelled.id).status, "cancelled");
    catalog.saveWorkflow(
      { ...secondDefinition, queued: false },
      secondSaved.revision,
    );
    assert.equal(
      host.launch("second", { context: "second" }, "second").id,
      second.id,
    );
    assert.equal(host.store.snapshot(second.id).workflow.queued, true);
    host.stop(first.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.store.get(second.id).status, "queued");
    gates.get("first")!.release.resolve();
    await gates.get("second")!.started.promise;
    assert.equal(host.store.get(first.id).status, "cancelled");
    assert.deepEqual(started, ["first", "parallel", "second"]);
    gates.get("second")!.release.resolve();
    gates.get("parallel")!.release.resolve();
    for (const run of [second, parallel])
      assert.equal(
        (await waitForRun(() => host.store.get(run.id))).status,
        "completed",
      );
    assert.equal(host.queueState().pending, 0);
    assert.equal(host.queueState().runs.length, 3);
  } finally {
    for (const gate of gates.values()) gate.release.resolve();
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("a blocked run releases the serial lane for the next workflow", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(serialWorkflow("first"));
  catalog.saveWorkflow(serialWorkflow("second"));
  const { backend, gates } = controlledBackend(["first", "second"]);
  const host = createRunHost(root, catalog, backend);
  try {
    const first = host.launch("first", { context: "first" }, "first");
    const second = host.launch("second", { context: "second" }, "second");
    await gates.get("first")!.started.promise;
    assert.equal(host.store.get(second.id).status, "queued");
    gates.get("first")!.release.reject(new Error("Agent failed"));
    await gates.get("second")!.started.promise;
    assert.equal(host.store.get(first.id).status, "blocked");
    assert.match(host.store.get(first.id).error!, /Agent failed/);
    gates.get("second")!.release.resolve();
    assert.equal(
      (await waitForRun(() => host.store.get(second.id))).status,
      "completed",
    );
  } finally {
    for (const gate of gates.values()) gate.release.resolve();
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("restart restores durable FIFO ordering and resume and rerun retain pinned queue participation", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = serialWorkflow("sample");
  const saved = catalog.saveWorkflow(definition);
  const { backend, gates, started } = controlledBackend([
    "legacy",
    "first",
    "second",
    "interrupted",
  ]);
  const store = createRunStore(root);
  const legacy = store.create(
    { ...definition, queued: undefined },
    [],
    { context: "legacy" },
    "legacy",
    backend.id,
  );
  delete legacy.queued;
  delete legacy.queueOrder;
  delete legacy.enqueuedAt;
  legacy.createdAt = "2020-01-01T00:00:00.000Z";
  store.save(legacy);
  const first = store.create(
    definition,
    [],
    { context: "first" },
    "first",
    backend.id,
  );
  const second = store.create(
    definition,
    [],
    { context: "second" },
    "second",
    backend.id,
  );
  // Creation timestamps must not override persisted admission order.
  second.createdAt = first.createdAt;
  store.save(second);
  const interrupted = store.create(
    definition,
    [],
    { context: "interrupted" },
    "interrupted",
    backend.id,
  );
  interrupted.status = "running";
  store.save(interrupted);
  catalog.saveWorkflow({ ...definition, queued: false }, saved.revision);
  const host = createRunHost(root, catalog, backend);
  try {
    await Promise.all([
      gates.get("legacy")!.started.promise,
      gates.get("first")!.started.promise,
    ]);
    assert.deepEqual(started, ["legacy", "first"]);
    assert.equal(store.get(interrupted.id).status, "blocked");
    host.resume(interrupted.id);
    assert(store.get(interrupted.id).queueOrder! > second.queueOrder!);
    assert.equal(store.get(interrupted.id).queued, true);
    gates.get("first")!.release.resolve();
    await gates.get("second")!.started.promise;
    assert.equal(store.get(interrupted.id).status, "queued");
    gates.get("second")!.release.resolve();
    await gates.get("interrupted")!.started.promise;
    gates.get("interrupted")!.release.resolve();
    gates.get("legacy")!.release.resolve();
    for (const run of [legacy, first, second, interrupted])
      assert.equal(
        (await waitForRun(() => store.get(run.id))).status,
        "completed",
      );
    await new Promise((resolve) => setImmediate(resolve));
    const rerun = host.rerun(second.id, "discover", "rerun");
    assert.equal(rerun.queued, true);
    assert(rerun.queueOrder! > store.get(interrupted.id).queueOrder!);
    assert.equal(
      (await waitForRun(() => store.get(rerun.id))).status,
      "completed",
    );
    assert.deepEqual(started, [
      "legacy",
      "first",
      "second",
      "interrupted",
      "second",
    ]);
  } finally {
    for (const gate of gates.values()) gate.release.resolve();
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});
