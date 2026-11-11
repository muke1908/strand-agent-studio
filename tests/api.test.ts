import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import type { AgentBackend } from "../server/agent-backend.ts";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { createWatcher } from "../server/watcher.ts";
import { createApp } from "../server/app.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import { executeRun } from "../server/run-engine.ts";
import { runAssets } from "../server/run-assets.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";
import type {
  QueueState,
  RunSummary,
  WatchDashboardItem,
} from "../shared/contracts.ts";
import { watchSchema } from "../shared/contracts.ts";
import { writeJson } from "../server/files.ts";
import { createRunStore } from "../server/run-store.ts";

test("plain-language inputs compile on save, preserve legacy schemas, and reject failed compilation", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const base = fixtureBackend();
  const compiled = {
    type: "object",
    required: ["prUrl"],
    properties: { prUrl: { type: "string", title: "PR URL", format: "uri" } },
    additionalProperties: false,
  };
  let compileCount = 0;
  let invalid = false;
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (
        request.purpose === "schema" &&
        request.prompt.includes("## Expected input")
      ) {
        compileCount++;
        assert.equal(request.allowAllTools, false);
        assert.deepEqual(request.allowedFolders, []);
        return invalid
          ? { status: "blocked", error: "Cannot compile" }
          : compiled;
      }
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  const watcher = createWatcher(root, catalog, host, []);
  const server = createApp(catalog, host, watcher, backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const put = (value: ReturnType<typeof workflow>, revision?: string) =>
    fetch(`${origin}/api/pipelines/${value.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value, revision }),
    });
  try {
    const definition = workflow("plain-input");
    definition.stages = [definition.stages[0]];
    definition.stages[0].inputs = {};
    const legacy = await put(definition);
    assert.equal(legacy.status, 200);
    const original = catalog.workflow(definition.id);
    assert.deepEqual(original.value.inputSchema, definition.inputSchema);
    assert.equal(compileCount, 0);

    definition.expectedInput = "A required PR URL.";
    const response = await put(definition, original.revision);
    assert.equal(response.status, 200);
    const saved = catalog.workflow(definition.id);
    assert.equal(saved.value.expectedInput, definition.expectedInput);
    assert.deepEqual(saved.value.inputSchema, compiled);
    assert.equal(compileCount, 1);
    const launch = (input: unknown) =>
      fetch(`${origin}/api/pipelines/${definition.id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, requestId: "compiled-input-launch" }),
      });
    assert.equal(
      (await launch({ context: "Old input is invalid" })).status,
      400,
    );
    const launched = await launch({ prUrl: "https://example.com/pr/1" });
    assert.equal(launched.status, 202);
    const run = await launched.json();
    assert.equal(
      (await waitForRun(() => host.store.get(run.id))).status,
      "completed",
    );

    assert.equal(
      (await put({ ...saved.value, name: "Renamed" }, saved.revision)).status,
      200,
    );
    assert.equal(
      compileCount,
      1,
      "Unchanged descriptions keep their compiled schema",
    );
    const renamed = catalog.workflow(definition.id);
    invalid = true;
    const failure = await put(
      { ...renamed.value, expectedInput: "An unsupported input." },
      renamed.revision,
    );
    assert.equal(failure.status, 400);
    assert.deepEqual(catalog.workflow(definition.id), renamed);
    assert.equal(compileCount, 2);

    const cleared = await put(
      { ...renamed.value, expectedInput: "" },
      renamed.revision,
    );
    assert.equal(cleared.status, 200);
    assert.deepEqual(catalog.workflow(definition.id).value.inputSchema, {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    assert.equal(
      compileCount,
      2,
      "Empty input descriptions need no model call",
    );
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(root, { recursive: true });
  }
});

test("run kinds use pinned definitions and group deletion preserves the other kind", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const backend = fixtureBackend();
  const host = createRunHost(root, catalog, backend);
  const watcher = createWatcher(root, catalog, host, []);
  const server = createApp(catalog, host, watcher, backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}/api`;
  const create = (definition: ReturnType<typeof workflow>) => {
    const run = host.store.create(
      definition,
      [],
      { context: "Pinned run classification" },
      `kind-${host.store.list().length}`,
      backend.id,
    );
    run.status = "completed";
    host.store.save(run);
    return run;
  };
  try {
    const definition = workflow();
    catalog.saveWorkflow(definition);
    const process = create(definition);
    const action = workflow();
    action.stages.length = 1;
    const single = create(action);
    const pinned = host.store.snapshot(single.id);
    const loop = workflow("deleted-loop");
    loop.stages.length = 1;
    loop.stages[0].loop = {
      targetStageId: loop.stages[0].id,
      condition: {
        agentId: loop.stages[0].agents[0].id,
        pointer: "/retry",
        operator: "equals",
        value: true,
      },
      maxIterations: 2,
      feedback: {},
    };
    const repeated = create(loop);
    const historyResponse = await fetch(`${origin}/pipeline-runs`);
    assert.equal(historyResponse.status, 200);
    const history: RunSummary[] = await historyResponse.json();
    const kinds = new Map(history.map((run) => [run.id, run.kind]));
    assert.equal(kinds.get(process.id), "workflow");
    assert.equal(kinds.get(single.id), "action");
    assert.equal(kinds.get(repeated.id), "workflow");
    for (const run of [process, single, repeated]) {
      const response = await fetch(`${origin}/pipeline-runs/${run.id}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).kind, kinds.get(run.id));
    }
    const remove = (kind: string) =>
      fetch(`${origin}/pipelines/${definition.id}/run-history?kind=${kind}`, {
        method: "DELETE",
      });
    assert.equal((await remove("unknown")).status, 400);
    const deleted = await remove("action");
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: 1 });
    assert.deepEqual(
      host.store
        .history()
        .map((run) => run.id)
        .sort(),
      [process.id, repeated.id].sort(),
    );
    assert.deepEqual(host.store.snapshot(single.id), pinned);
    const details = await fetch(`${origin}/pipeline-runs/${single.id}`);
    assert.equal(details.status, 200);
    assert.equal((await details.json()).kind, "action");
  } finally {
    await host.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true });
  }
});

test("run history deletion persists without breaking run records, watches or submission identities", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = workflow();
  catalog.saveWorkflow(definition);
  catalog.saveWatch(
    watchSchema.parse({
      id: "daily",
      name: "Daily sample",
      workflowId: definition.id,
      enabled: true,
      policyId: "schedule-cron",
      settings: { expression: "0 9 * * *", timeZone: "UTC" },
      inputBindings: {
        context: { source: "literal", value: "History" },
      },
    }),
  );
  const backend = fixtureBackend();
  const host = createRunHost(root, catalog, backend);
  const watcher = createWatcher(root, catalog, host, []);
  const server = createApp(catalog, host, watcher, backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (url: string, method = "GET") =>
    fetch(`${origin}/api${url}`, { method });
  const create = (
    id: string,
    status:
      | "completed"
      | "blocked"
      | "cancelled"
      | "queued"
      | "running" = "completed",
  ) => {
    const run = host.store.create(
      workflow(id),
      [],
      { context: "History" },
      `history-${host.store.list().length}`,
      backend.id,
    );
    run.status = status;
    run.queued = true;
    host.store.save(run);
    return run;
  };
  try {
    const runs = Array.from({ length: 13 }, () => create("sample"));
    const kept = create("other");
    const deleted = runs[0];
    const snapshot = host.store.snapshot(deleted.id);
    writeJson(path.join(root, "watch-state", "daily.json"), {
      id: "daily",
      nextCheck: new Date().toISOString(),
      decisions: [
        {
          eventId: "watched",
          resourceId: "sample",
          reason: "History",
          input: { context: "History" },
          observedAt: new Date().toISOString(),
          status: "launched",
          runId: deleted.id,
        },
      ],
    });
    assert.equal(
      (await request(`/pipeline-runs/${deleted.id}`, "DELETE")).status,
      200,
    );
    assert.equal((await request("/pipeline-runs")).status, 200);
    assert(!host.store.history().some((run) => run.id === deleted.id));
    assert(
      !createRunStore(root)
        .history()
        .some((run) => run.id === deleted.id),
    );
    assert.equal(host.store.get(deleted.id).updatedAt, deleted.updatedAt);
    assert.equal((await request(`/pipeline-runs/${deleted.id}`)).status, 200);
    assert.deepEqual(host.store.snapshot(deleted.id), snapshot);
    host.store.verify(deleted.id);
    const dashboard = await request("/watch-dashboard");
    assert.equal(dashboard.status, 200);
    assert.equal((await dashboard.json())[0].latestRun.id, deleted.id);
    assert.equal(
      host.launch("sample", { context: "History" }, deleted.requestId).id,
      deleted.id,
    );
    const queue = await request("/queue");
    assert(
      !(await queue.json()).runs.some(
        (run: { id: string }) => run.id === deleted.id,
      ),
    );
    assert.equal(
      (await request("/pipeline-runs/missing", "DELETE")).status,
      404,
    );

    const queued = create("sample", "queued");
    const running = create("sample", "running");
    for (const run of [queued, running])
      assert.equal(
        (await request(`/pipeline-runs/${run.id}`, "DELETE")).status,
        409,
      );
    const group = "/pipelines/sample/run-history";
    assert.equal((await request(group, "DELETE")).status, 409);
    assert.equal(
      host.store.history().filter((run) => run.workflowId === "sample").length,
      14,
    );
    for (const run of [queued, running]) {
      run.status = run.id === queued.id ? "cancelled" : "blocked";
      host.store.save(run);
    }
    const response = await request(group, "DELETE");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: 14 });
    assert.deepEqual(
      (await (await request("/pipeline-runs")).json()).map(
        (run: { id: string }) => run.id,
      ),
      [kept.id],
    );
    assert.deepEqual(
      createRunStore(root)
        .history()
        .map((run) => run.id),
      [kept.id],
    );
    assert.equal(catalog.workflow("sample").value.id, "sample");
    assert.deepEqual(await (await request(group, "DELETE")).json(), {
      deleted: 0,
    });
    const fresh = create("sample");
    assert(host.store.history().some((run) => run.id === fresh.id));
    const restored = host.store.get(queued.id);
    host.store.enqueue(restored);
    assert(host.store.history().some((run) => run.id === queued.id));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("watch deletion API checks revisions, removes scheduling state and preserves runs", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  const saved = catalog.saveWatch(
    watchSchema.parse({
      id: "daily",
      name: "Daily sample",
      workflowId: "sample",
      enabled: true,
      policyId: "schedule-cron",
      settings: { expression: "0 9 * * *", timeZone: "UTC" },
      inputBindings: {
        context: { source: "literal", value: "Scheduled context" },
      },
    }),
  );
  const backend = fixtureBackend();
  const host = createRunHost(root, catalog, backend);
  const watcher = createWatcher(root, catalog, host, []);
  const server = createApp(catalog, host, watcher, backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const stateFile = path.join(root, "watch-state", "daily.json");
  const state = {
    id: "daily",
    nextCheck: new Date().toISOString(),
    decisions: [],
  };
  writeJson(stateFile, state);
  const remove = (body: unknown) =>
    fetch(`${origin}/api/pipeline-watches/daily`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    for (const body of [
      {},
      { revision: "" },
      { revision: saved.revision, force: true },
    ])
      assert.equal((await remove(body)).status, 400);
    const stale = await remove({ revision: "stale" });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /Reload before deleting/);
    assert.deepEqual(catalog.watch("daily"), saved);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), state);

    const run = host.launch("sample", { context: "Keep history" }, "kept", {
      watchId: "daily",
      eventId: "scheduled",
      reason: "Daily check",
    });
    const snapshot = host.store.snapshot(run.id);
    const deleted = await remove({ revision: saved.revision });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.equal(fs.existsSync(stateFile), false);
    for (const endpoint of ["/pipeline-watches", "/watch-dashboard"]) {
      const response = await fetch(`${origin}/api${endpoint}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), []);
    }
    assert.equal((await remove({ revision: saved.revision })).status, 404);
    assert.equal(
      (await waitForRun(() => host.store.get(run.id))).status,
      "completed",
    );
    assert.equal(
      (await fetch(`${origin}/api/pipeline-runs/${run.id}`)).status,
      200,
    );
    assert.deepEqual(host.store.snapshot(run.id), snapshot);
    host.store.verify(run.id);
    assert.equal(catalog.workflow("sample").value.id, "sample");
    assert.throws(() => createCatalog(root).watch("daily"), { status: 404 });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("queue API returns the latest 30 participating submissions and counts older pending runs", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const backend = fixtureBackend();
  const host = createRunHost(root, catalog, backend);
  const watcher = createWatcher(root, catalog, host, []);
  const server = createApp(catalog, host, watcher, backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const read = async (): Promise<QueueState> => {
      const response = await fetch(`${origin}/api/queue`);
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await read(), { runs: [], pending: 0, running: 0 });
    const definition = { ...workflow(), queued: true };
    const runs = Array.from({ length: 33 }, (_, index) => {
      const run = host.store.create(
        definition,
        [],
        { context: "Queue history" },
        `queue-${index}`,
        backend.id,
      );
      run.status =
        index < 2
          ? "queued"
          : index === 32
            ? "running"
            : (["completed", "blocked", "cancelled"] as const)[index % 3];
      host.store.save(run);
      return run;
    });
    host.store.create(
      workflow("parallel"),
      [],
      { context: "Not a serial submission" },
      "parallel",
      backend.id,
    );
    const queue = await read();
    assert.equal(queue.pending, 2);
    assert.equal(queue.running, 1);
    assert.deepEqual(
      queue.runs.map((run) => run.id),
      runs
        .slice(3)
        .reverse()
        .map((run) => run.id),
    );
    assert(queue.runs.every((run) => run.queued));
    assert.deepEqual(
      new Set(queue.runs.map((run) => run.status)),
      new Set(["running", "completed", "blocked", "cancelled"]),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("watch dashboard retains each watch's previous output until its next scheduled result", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = workflow();
  definition.stages = [definition.stages[0]];
  definition.stages[0].agents = [definition.stages[0].agents[0]];
  definition.result = {
    source: "stage",
    stageId: "discover",
    agentId: "alpha",
    pointer: "",
  };
  catalog.saveWorkflow(definition);
  const base = fixtureBackend();
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      return request.purpose === "stage"
        ? { summary: "No assigned PRs.", assignedPrCount: 0 }
        : base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  const policy = {
    id: "sample-change",
    name: "Sample change",
    description: "",
    settingsSchema: { type: "object" },
    async evaluate() {
      return {
        cursor: "A",
        candidates: [
          {
            eventId: "A",
            resourceId: "sample",
            reason: "Changed",
            payload: {},
          },
        ],
      };
    },
  };
  const watcher = createWatcher(root, catalog, host, [policy]);
  const server = createApp(catalog, host, watcher, backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const origin = `http://127.0.0.1:${address.port}`;
  const read = async (): Promise<WatchDashboardItem[]> => {
    const response = await fetch(`${origin}/api/watch-dashboard`);
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    assert.deepEqual(await read(), []);
    const watches = ["first", "second", "waiting"].map(
      (id) =>
        catalog.saveWatch({
          id,
          name: id,
          workflowId: definition.id,
          enabled: true,
          policyId: policy.id,
          settings: {},
          inputBindings: { context: { source: "literal", value: id } },
          cooldownSeconds: 0,
          maxRunsPerHour: 10,
        }).value,
    );
    for (const watch of watches.slice(0, 2)) {
      const state = await watcher.evaluate(watch);
      await waitForRun(() => host.store.get(state.decisions[0].runId!));
    }
    const manual = host.launch(
      definition.id,
      { context: "Manual" },
      "dashboard-manual",
    );
    await waitForRun(() => host.store.get(manual.id));
    const items = await read();
    assert.equal(items.length, 3);
    assert.equal(items[2].latestRun, undefined);
    assert.equal(items[2].previousResultRun, undefined);
    for (const item of items.slice(0, 2)) {
      assert.equal(
        item.latestRun?.id,
        watcher.state(item.value.id).decisions[0].runId,
      );
      assert.notEqual(item.latestRun?.id, manual.id);
      assert.deepEqual(item.latestRun?.result, {
        summary: "No assigned PRs.",
        assignedPrCount: 0,
      });
      assert(!("units" in item.latestRun!));
      assert.equal(item.previousResultRun, undefined);
    }
    assert.notEqual(items[0].latestRun?.id, items[1].latestRun?.id);
    const prior = host.store.get(items[0].latestRun!.id);
    const newer = host.store.create(
      definition,
      [],
      { context: "Newest" },
      "dashboard-newer",
      backend.id,
      { watchId: "first", eventId: "B", reason: "Newer scheduled run" },
    );
    const state = watcher.state("first");
    state.decisions.push({
      eventId: "B",
      resourceId: "sample",
      reason: "Changed",
      input: {},
      observedAt: new Date().toISOString(),
      status: "launched",
      runId: newer.id,
    });
    fs.writeFileSync(
      path.join(root, "watch-state", "first.json"),
      JSON.stringify(state),
    );
    for (const status of ["queued", "running", "blocked"] as const) {
      newer.status = status;
      if (status === "blocked") newer.error = "Azure authentication expired";
      host.store.save(newer);
      const updated = await read();
      assert.equal(updated[0].latestRun?.id, newer.id);
      assert.equal(updated[0].latestRun?.status, status);
      assert.equal(updated[0].latestRun?.error, newer.error);
      assert.equal(updated[0].latestRun?.result, undefined);
      assert.deepEqual(updated[0].previousResultRun, {
        id: prior.id,
        updatedAt: prior.updatedAt,
        result: prior.result,
      });
      assert.deepEqual(updated[1], items[1]);
    }
    newer.status = "completed";
    delete newer.error;
    newer.result = { summary: "Seven assigned PRs.", assignedPrCount: 7 };
    host.store.save(newer);
    const updated = await read();
    assert.deepEqual(updated[0].latestRun?.result, newer.result);
    assert.equal(updated[0].previousResultRun, undefined);
    assert.deepEqual(updated[1], items[1]);
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("completed run downloads contain only final results and reports, ignoring oversized execution files", async () => {
  const root = temporaryRoot();
  const reports = path.join(fs.realpathSync(root), "reports");
  fs.mkdirSync(reports);
  const reportFile = path.join(reports, "feature-report.md");
  const reportText = "# Feature report\nVerified implementation and tests.";
  fs.writeFileSync(reportFile, reportText);
  const reportHash = createHash("sha256").update(reportText).digest("hex");
  const intermediate = path.join(reports, "intermediate.md");
  fs.writeFileSync(intermediate, "# Intermediate evidence");
  const intermediateHash = createHash("sha256")
    .update(fs.readFileSync(intermediate))
    .digest("hex");
  const fixture = fixtureBackend();
  const backend: AgentBackend = {
    ...fixture,
    async execute(request, signal) {
      if (
        request.purpose === "stage" &&
        path.basename(request.directory).startsWith("discover-alpha-") &&
        Object.hasOwn(request.schema.properties ?? {}, "report")
      )
        return {
          summary: "Intermediate evidence",
          report: { path: intermediate, sha256: intermediateHash },
        };
      if (
        request.purpose === "stage" &&
        path.basename(request.directory).startsWith("report-writer-")
      )
        return {
          summary: "Published fixture report.",
          report: { path: reportFile, sha256: reportHash },
        };
      return fixture.execute(request, signal);
    },
  };
  const definition = workflow();
  definition.stages[0].outputSchema.properties = {
    ...definition.stages[0].outputSchema.properties,
    report: { type: "object" },
  };
  definition.stages[1].agents[0].allowedFolders = [reports];
  const catalog = createCatalog(root);
  catalog.saveWorkflow(definition);
  const host = createRunHost(root, catalog, backend);
  const watcher = createWatcher(root, catalog, host, []);
  const server = createApp(catalog, host, watcher, backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const origin = `http://127.0.0.1:${address.port}`;
  const assets = (id: string, headers?: HeadersInit) =>
    fetch(`${origin}/api/pipeline-runs/${id}/assets`, { headers });
  try {
    const incomplete = host.store.create(
      definition,
      [],
      { context: "Not finished" },
      "incomplete-assets",
      backend.id,
    );
    for (const status of [
      "queued",
      "running",
      "blocked",
      "cancelled",
    ] as const) {
      incomplete.status = status;
      host.store.save(incomplete);
      assert.equal((await assets(incomplete.id)).status, 409);
    }
    assert.equal((await assets("run-missing")).status, 404);
    const started = host.launch(
      definition.id,
      { context: "Download evidence" },
      "download-assets",
    );
    const run = await waitForRun(() => host.store.get(started.id));
    assert.equal(run.status, "completed", run.error);
    const directory = host.store.directory(run.id);
    const attempt = path.join(
      directory,
      "attempts",
      run.units["report/writer"].attempts[0].id,
    );
    fs.mkdirSync(attempt, { recursive: true });
    fs.writeFileSync(path.join(attempt, "stdout.log"), "Fixture execution log");
    fs.writeFileSync(path.join(directory, "unrelated.txt"), "Do not export");
    const downloaded = await assets(run.id);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get("content-type")!, /application\/zip/);
    assert.match(
      downloaded.headers.get("content-disposition")!,
      new RegExp(`${run.id}-assets\\.zip`),
    );
    assert.equal(downloaded.headers.get("cache-control"), "no-store");
    const archive = unzipSync(new Uint8Array(await downloaded.arrayBuffer()));
    assert.equal(
      strFromU8(archive["reports/report-writer/feature-report.md"]),
      reportText,
    );
    assert.deepEqual(JSON.parse(strFromU8(archive["result.json"])), run.result);
    assert.deepEqual(Object.keys(archive).sort(), [
      "reports/report-writer/feature-report.md",
      "result.json",
    ]);
    assert.equal(
      (await assets(run.id, { Origin: "https://example.com" })).status,
      403,
    );

    fs.writeFileSync(reportFile, "Changed report");
    const changed = await assets(run.id);
    assert.equal(changed.status, 409);
    assert.match((await changed.json()).error, /report changed/);
    fs.writeFileSync(reportFile, reportText);
    const deniedDefinition = workflow("assets-no-grant");
    catalog.saveWorkflow(deniedDefinition);
    const denied = host.launch(
      deniedDefinition.id,
      { context: "Outside pinned grants" },
      "denied-assets",
    );
    assert.equal(
      (await waitForRun(() => host.store.get(denied.id))).status,
      "completed",
    );
    const outside = await assets(denied.id);
    assert.equal(outside.status, 409);
    assert.match(
      (await outside.json()).error,
      /outside.*pinned allowed folders/,
    );

    const link = path.join(attempt, "external-link");
    fs.symlinkSync(reports, link);
    assert.equal((await assets(run.id)).status, 200);
    fs.unlinkSync(link);
    const large = path.join(directory, "large.json");
    fs.writeFileSync(large, "");
    fs.truncateSync(large, 64 * 1024 * 1024 + 1);
    fs.truncateSync(path.join(attempt, "stdout.log"), 64 * 1024 * 1024 + 1);
    assert.equal((await assets(run.id)).status, 200);
    fs.truncateSync(reportFile, 64 * 1024 * 1024 + 1);
    assert.equal((await assets(run.id)).status, 413);
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("downloads include every final agent's nested file references without a report contract", async () => {
  const root = temporaryRoot();
  const reports = path.join(fs.realpathSync(root), "reports");
  fs.mkdirSync(path.join(reports, "nested"), { recursive: true });
  const report = path.join(reports, "findings.md");
  const diagram = path.join(reports, "diagrams.md");
  const nested = path.join(reports, "nested", "findings.md");
  const outside = path.join(fs.realpathSync(root), "source.ts");
  const citedLog = path.join(reports, "evidence.log");
  fs.writeFileSync(report, "# Findings");
  fs.writeFileSync(diagram, "```mermaid\nflowchart TD\nA --> B\n```");
  fs.writeFileSync(nested, "# Supporting findings");
  fs.writeFileSync(outside, "Unrelated source");
  fs.writeFileSync(citedLog, "Cited evidence, not a final artifact");
  fs.writeFileSync(path.join(reports, "unreferenced.md"), "Not an output");
  const definition = workflow();
  definition.stages[1].agents = [
    { id: "writer", name: "Writer", allowedFolders: [reports] },
    { id: "diagram", name: "Diagram", allowedFolders: [reports] },
  ];
  definition.result = {
    source: "stage",
    stageId: "report",
    agentId: "writer",
    pointer: "",
  };
  const fixture = fixtureBackend();
  const backend: AgentBackend = {
    ...fixture,
    async execute(request, signal) {
      if (request.purpose === "stage") {
        if (path.basename(request.directory).startsWith("report-writer-"))
          return {
            summary: "Findings",
            reportArtifact: { reportPath: report },
            files: [nested],
            evidence: [{ paths: [nested, report, outside, citedLog] }],
            workspace: reports,
          };
        if (path.basename(request.directory).startsWith("report-diagram-"))
          return {
            summary: "Diagrams",
            diagramArtifacts: { paths: [diagram] },
          };
      }
      return fixture.execute(request, signal);
    },
  };
  const catalog = createCatalog(root);
  catalog.saveWorkflow(definition);
  const host = createRunHost(root, catalog, backend);
  try {
    const started = host.launch(
      definition.id,
      { context: "Final artifacts" },
      "final-artifacts",
    );
    const run = await waitForRun(() => host.store.get(started.id));
    assert.equal(run.status, "completed", run.error);
    const archive = unzipSync(runAssets(host.store, run.id));
    assert.equal(
      strFromU8(archive["outputs/report-writer/1/findings.md"]),
      "# Findings",
    );
    assert.equal(
      strFromU8(archive["outputs/report-writer/1/nested/findings.md"]),
      "# Supporting findings",
    );
    assert.equal(
      strFromU8(archive["outputs/report-diagram/1/diagrams.md"]),
      fs.readFileSync(diagram, "utf8"),
    );
    assert.deepEqual(
      Object.keys(archive)
        .filter((name) => name.startsWith("outputs/"))
        .sort(),
      [
        "outputs/report-diagram/1/diagrams.md",
        "outputs/report-writer/1/findings.md",
        "outputs/report-writer/1/nested/findings.md",
      ],
    );
    assert.deepEqual(JSON.parse(strFromU8(archive["result.json"])), run.result);
    assert(
      !Object.keys(archive).some((name) =>
        /source\.ts|unreferenced|evidence\.log/.test(name),
      ),
    );

    fs.unlinkSync(report);
    fs.symlinkSync(outside, report);
    assert.throws(() => runAssets(host.store, run.id), /symbolic links/);
    fs.unlinkSync(report);
    fs.writeFileSync(report, "# Findings");
    fs.unlinkSync(nested);
    fs.rmdirSync(path.dirname(nested));
    fs.symlinkSync(path.dirname(outside), path.dirname(nested));
    fs.writeFileSync(
      path.join(path.dirname(outside), "findings.md"),
      "Outside",
    );
    assert.throws(
      () => runAssets(host.store, run.id),
      /outside.*pinned allowed folders/,
    );
    fs.unlinkSync(path.dirname(nested));
    fs.mkdirSync(path.dirname(nested));
    assert.throws(() => runAssets(host.store, run.id), /ENOENT/);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("blocked publication downloads preserve Markdown reportPaths without claiming a completed result", async () => {
  const root = temporaryRoot();
  const reports = path.join(fs.realpathSync(root), "reports");
  fs.mkdirSync(reports);
  const report = path.join(reports, "digest.md");
  fs.writeFileSync(
    report,
    "# Teams digest\n\n## Important\nDetailed findings.",
  );
  const definition = workflow();
  definition.stages[1].agents[0].allowedFolders = [reports];
  const fixture = fixtureBackend();
  const backend: AgentBackend = {
    ...fixture,
    async execute(request, signal) {
      if (
        request.purpose === "stage" &&
        path.basename(request.directory).startsWith("report-writer-")
      )
        return {
          status: "blocked",
          summary: "File upload access denied.",
          reportPaths: [report],
        };
      return fixture.execute(request, signal);
    },
  };
  const catalog = createCatalog(root);
  catalog.saveWorkflow(definition);
  const host = createRunHost(root, catalog, backend);
  try {
    const started = host.launch(
      definition.id,
      { context: "Report survives publication failure" },
      "blocked-markdown",
    );
    const run = await waitForRun(() => host.store.get(started.id));
    assert.equal(run.status, "blocked", run.error);
    const archive = unzipSync(runAssets(host.store, run.id));
    assert.equal(
      strFromU8(archive["outputs/report-writer/1/digest.md"]),
      fs.readFileSync(report, "utf8"),
    );
    assert.equal(
      JSON.parse(strFromU8(archive["run-status.json"])).status,
      "blocked",
    );
    assert.equal(
      JSON.parse(strFromU8(archive["outputs/report-writer.json"])).output
        .status,
      "blocked",
    );
    assert(!Object.hasOwn(archive, "result.json"));
    fs.unlinkSync(report);
    assert.throws(() => runAssets(host.store, run.id), /ENOENT/);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("instruction file browsing and saves reject invalid Markdown without changing saved workflows", async () => {
  const root = temporaryRoot();
  const directory = path.join(root, "instructions");
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, "nested"));
  fs.mkdirSync(path.join(directory, "directory.md"));
  fs.writeFileSync(path.join(directory, "agent.MD"), "# Agent\nUse evidence.");
  fs.writeFileSync(path.join(directory, "not-markdown.txt"), "Not Markdown.");
  fs.writeFileSync(path.join(directory, "empty.md"), "  \n");
  fs.writeFileSync(path.join(directory, "large.md"), "x".repeat(50001));
  fs.writeFileSync(path.join(directory, "invalid.md"), Buffer.from([0xff]));
  const catalog = createCatalog(root);
  const saved = catalog.saveWorkflow(workflow());
  const backend = fixtureBackend();
  const host = createRunHost(root, catalog, backend);
  const watcher = createWatcher(root, catalog, host, []);
  const server = createApp(catalog, host, watcher, backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const listing = await fetch(
      `${origin}/api/instruction-files?directory=${encodeURIComponent(directory)}`,
    );
    assert.equal(listing.status, 200);
    const data = await listing.json();
    assert.equal(data.directory, fs.realpathSync(directory));
    assert(
      data.entries.some((entry: { name: string }) => entry.name === "agent.MD"),
    );
    assert(
      data.entries.some((entry: { name: string }) => entry.name === "nested"),
    );
    assert(
      !data.entries.some(
        (entry: { name: string }) => entry.name === "not-markdown.txt",
      ),
    );
    const foreign = await fetch(`${origin}/api/instruction-files`, {
      headers: { Origin: "https://example.com" },
    });
    assert.equal(foreign.status, 403);
    const badDirectory = await fetch(
      `${origin}/api/instruction-files?directory=relative`,
    );
    assert.equal(badDirectory.status, 400);
    for (const [file, message] of [
      ["relative.md", "STRAND_WORKFLOWS_DIR"],
      [path.join(directory, "missing.md"), "ENOENT"],
      [path.join(directory, "not-markdown.txt"), ".md file"],
      [path.join(directory, "empty.md"), "cannot be empty"],
      [path.join(directory, "large.md"), "50,000-character"],
      [path.join(directory, "directory.md"), "regular file"],
      [path.join(directory, "invalid.md"), "encoded data"],
    ]) {
      const value = structuredClone(saved.value);
      value.stages[0].agents[0].instructionsFile = file;
      const rejected = await fetch(`${origin}/api/pipelines/${value.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value, revision: saved.revision }),
      });
      assert.equal(rejected.status, 400);
      assert((await rejected.json()).error.includes(message));
      assert.deepEqual(catalog.workflow(value.id), saved);
    }
    assert.equal(host.store.list().length, 0);
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP API validates launches, blocks foreign origins and never serves HTML for missing API routes", async () => {
  const root = temporaryRoot();
  const folder = path.join(root, "project with spaces");
  const otherFolder = path.join(root, "another project");
  const ordinaryFile = path.join(root, "file.txt");
  fs.mkdirSync(folder);
  fs.mkdirSync(otherFolder);
  fs.writeFileSync(ordinaryFile, "Not a directory.");
  const allowedFolders = [
    fs.realpathSync(folder),
    fs.realpathSync(otherFolder),
  ].sort();
  const catalog = createCatalog(root);
  const definition = workflow();
  definition.stages[1].agents[0].instructions = "Explain uncertainty.";
  definition.stages[1].agents[0].allowedFolders = [folder, otherFolder, folder];
  definition.stages[1].skills = ["evidence"];
  definition.stages[1].agents[0].skills = ["evidence"];
  const skill = catalog.saveSkill({
    id: "evidence",
    name: "Evidence checks",
    description: "",
    instructions: "# Evidence\nSeparate facts from assumptions.",
  });
  catalog.saveWorkflow(definition);
  const backend = fixtureBackend();
  const host = createRunHost(root, catalog, backend);
  const watcher = createWatcher(root, catalog, host, []);
  const server = createApp(catalog, host, watcher, backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const foreign = await fetch(`${origin}/api/pipelines`, {
      headers: { Origin: "http://localhost:9000" },
    });
    assert.equal(foreign.status, 403);
    const missing = await fetch(`${origin}/api/unknown`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type")!, /json/);
    const invalid = await fetch(`${origin}/api/pipelines/sample/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, requestId: "bad-http" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(host.store.list().length, 0);
    const invalidPermission = await fetch(
      `${origin}/api/pipelines/sample/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { context: "HTTP evidence" },
          requestId: "invalid-permission",
          allowAllTools: "true",
        }),
      },
    );
    assert.equal(invalidPermission.status, 400);
    assert.equal(host.store.list().length, 0);
    for (const folders of [
      "not-an-array",
      [""],
      ["/invalid\0folder"],
      ["relative/project"],
      [path.join(root, "missing-folder")],
      [path.join(root, "a".repeat(256))],
      [ordinaryFile],
    ]) {
      const invalidFolders = await fetch(`${origin}/api/pipelines/sample`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: {
            ...definition,
            stages: definition.stages.map((stage) => ({
              ...stage,
              agents: stage.agents.map((agent) => ({
                ...agent,
                allowedFolders: folders,
              })),
            })),
          },
          revision: catalog.workflow("sample").revision,
        }),
      });
      assert.equal(invalidFolders.status, 400);
    }
    assert.equal(host.store.list().length, 0);
    const accepted = await fetch(`${origin}/api/pipelines/sample/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { context: "HTTP evidence" },
        requestId: "good-http",
        allowAllTools: true,
      }),
    });
    assert.equal(accepted.status, 202);
    const run = await accepted.json();
    assert.equal(run.allowAllTools, true);
    assert.equal(host.store.snapshot(run.id).allowAllTools, true);
    assert.equal(run.allowedFolders, undefined);
    assert.deepEqual(
      host.store.snapshot(run.id).workflow.stages[1].agents[0].allowedFolders,
      allowedFolders,
    );
    const sameRequest = await fetch(`${origin}/api/pipelines/sample/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { context: "HTTP evidence" },
        requestId: "good-http",
        allowAllTools: true,
      }),
    });
    assert.equal(sameRequest.status, 202);
    assert.equal((await sameRequest.json()).id, run.id);
    const launchFolderOverride = await fetch(
      `${origin}/api/pipelines/sample/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { context: "HTTP evidence" },
          requestId: "good-http",
          allowAllTools: true,
          allowedFolders: [],
        }),
      },
    );
    assert.equal(launchFolderOverride.status, 400);
    const conflictingPermission = await fetch(
      `${origin}/api/pipelines/sample/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { context: "HTTP evidence" },
          requestId: "good-http",
          allowAllTools: false,
        }),
      },
    );
    assert.equal(conflictingPermission.status, 409);
    assert.equal(
      (await waitForRun(() => host.store.get(run.id))).status,
      "completed",
    );
    const current = catalog.workflow("sample");
    catalog.saveSkill(
      { ...skill.value, instructions: "Changed after this run." },
      skill.revision,
    );
    catalog.saveWorkflow(
      {
        ...current.value,
        stages: [
          { ...current.value.stages[0], outputSchema: { type: "string" } },
        ],
      },
      current.revision,
    );
    const runDetailsResponse = await fetch(
      `${origin}/api/pipeline-runs/${run.id}`,
    );
    assert.equal(runDetailsResponse.status, 200);
    const runDetails = await runDetailsResponse.json();
    assert.equal(runDetails.kind, "workflow");
    assert.deepEqual(
      runDetails.stages,
      definition.stages.map(({ id, name, agents }) => ({
        id,
        name,
        agents: agents.map(({ id, name }) => ({ id, name })),
      })),
      "Run stages must come from the pinned snapshot, not the edited workflow",
    );
    const contractResponse = await fetch(
      `${origin}/api/pipeline-runs/${run.id}/activity?unit=${encodeURIComponent("@schema/discover")}`,
    );
    assert.equal(contractResponse.status, 200);
    const contract = await contractResponse.json();
    assert.deepEqual(contract.input, workflow().stages[0].outputSchema);
    assert.deepEqual(contract.output, workflow().stages[0].outputSchema);
    const activityResponse = await fetch(
      `${origin}/api/pipeline-runs/${run.id}/activity?unit=${encodeURIComponent("report/writer")}`,
    );
    assert.equal(activityResponse.status, 200);
    const activity = await activityResponse.json();
    assert.deepEqual(activity.input, {
      agentInstructions: "Explain uncertainty.",
      allowedFolders,
      skills: [skill.value],
      workflowInput: { context: "HTTP evidence" },
      stageInput: { evidence: "Fixture output - automated testing only" },
      handoffs: {
        "discover/alpha": {
          summary: "Fixture output - automated testing only",
        },
        "discover/beta": { summary: "Fixture output - automated testing only" },
      },
    });
    assert.deepEqual(activity.output, {
      summary: "Fixture output - automated testing only",
    });
    const absent = await fetch(
      `${origin}/api/pipeline-runs/${run.id}/activity?unit=missing`,
    );
    assert.equal(absent.status, 404);
    const missingKey = await fetch(
      `${origin}/api/pipeline-runs/${run.id}/activity`,
    );
    assert.equal(missingKey.status, 400);
    const missingRevision = await fetch(`${origin}/api/pipelines/sample`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(missingRevision.status, 400);
    const staleDelete = await fetch(`${origin}/api/pipelines/sample`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: "stale" }),
    });
    assert.equal(staleDelete.status, 409);
    const deleted = await fetch(`${origin}/api/pipelines/sample`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: catalog.workflow("sample").revision }),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.equal((await fetch(`${origin}/api/pipelines/sample`)).status, 404);
    assert.equal(
      (await fetch(`${origin}/api/pipeline-runs/${run.id}`)).status,
      200,
    );
    const sourceBeforeRerun = host.store.get(run.id);
    for (const body of [
      { stageId: "report" },
      { stageId: "report", requestId: "invalid-rerun", allowAllTools: true },
      { stageId: "report", requestId: "invalid-rerun", allowedFolders: [] },
    ]) {
      const response = await fetch(
        `${origin}/api/pipeline-runs/${run.id}/rerun`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      assert.equal(
        response.status,
        400,
        "A rerun cannot override pinned permissions",
      );
    }
    const rerun = () =>
      fetch(`${origin}/api/pipeline-runs/${run.id}/rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId: "report", requestId: "http-rerun" }),
      });
    const continued = await rerun();
    assert.equal(continued.status, 202);
    const child = await continued.json();
    assert.deepEqual(child.continuation, {
      sourceRunId: run.id,
      fromStageId: "report",
    });
    assert.notEqual(child.id, run.id);
    assert.equal((await (await rerun()).json()).id, child.id);
    const finished = await waitForRun(() => host.store.get(child.id));
    assert.equal(finished.status, "completed", finished.error);
    assert.equal(finished.units["discover/alpha"].reusedFrom, run.id);
    assert.equal(finished.units["report/writer"].attempts.length, 1);
    assert.deepEqual(host.store.get(run.id), sourceBeforeRerun);
    const legacy = host.store.create(
      workflow(),
      [],
      { context: "Existing run" },
      "legacy-summary",
      backend.id,
    );
    await executeRun(
      host.store,
      legacy.id,
      backend,
      new AbortController().signal,
    );
    const beforeSummary = host.store.get(legacy.id);
    const legacyUrl = `${origin}/api/pipeline-runs/${legacy.id}`;
    assert.equal(
      (await (await fetch(legacyUrl)).json()).resultSummary,
      undefined,
    );
    const overridden = await fetch(`${legacyUrl}/result-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowAllTools: true }),
    });
    assert.equal(overridden.status, 400);
    const summaryResponse = await fetch(`${legacyUrl}/result-summary`, {
      method: "POST",
    });
    assert.equal(summaryResponse.status, 202);
    let detail;
    for (let attempt = 0; attempt < 300; attempt++) {
      detail = await (await fetch(legacyUrl)).json();
      if (detail.resultSummary?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(detail.resultSummary.status, "completed");
    assert.equal(detail.resultSummary.lines.length, 2);
    const cachedSummary = await fetch(`${legacyUrl}/result-summary`, {
      method: "POST",
    });
    assert.deepEqual(await cachedSummary.json(), detail.resultSummary);
    assert.deepEqual(host.store.get(legacy.id), beforeSummary);
    const absentSummaryRun = await fetch(
      `${origin}/api/pipeline-runs/run-missing/result-summary`,
      { method: "POST" },
    );
    assert.equal(absentSummaryRun.status, 404);
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(root, { recursive: true });
  }
});
