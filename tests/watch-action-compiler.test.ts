import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AgentBackend, AgentRequest } from "../server/agent-backend.ts";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { createWatcher } from "../server/watcher.ts";
import { createApp } from "../server/app.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import type { Json, Watch } from "../shared/contracts.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";

const sentence =
  "Run when there are open comments and the last comment is more than 30 minutes old.";
function plan() {
  return {
    status: "ready",
    reason: "There must be open comments and more than 30 minutes of quiet.",
    conditions: [
      { pointer: "/status", operator: "equals", value: "ready" },
      { pointer: "/openCommentCount", operator: "greaterThan", value: 0 },
      { pointer: "/lastCommentPostedAt", operator: "notEquals", value: null },
      {
        pointer: "/lastCommentPostedAt",
        operator: "olderThanSeconds",
        value: 1800,
      },
    ],
    deduplicationPointer: null,
  };
}
function setup() {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const check = workflow("check");
  check.inputSchema = {
    type: "object",
    properties: { prUrl: { type: "string" } },
    required: ["prUrl"],
    additionalProperties: false,
  };
  check.stages = [check.stages[0]];
  check.stages[0].agents = [check.stages[0].agents[0]];
  check.stages[0].inputs = {};
  check.stages[0].expectedOutput = "The PR's comment counts and readiness.";
  check.stages[0].outputSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ready", "waiting"] },
      openCommentCount: { type: "integer" },
      lastCommentPostedAt: { type: ["string", "null"] },
    },
    required: ["status", "openCommentCount", "lastCommentPostedAt"],
    additionalProperties: false,
  };
  check.result = {
    source: "stage",
    stageId: "discover",
    agentId: "alpha",
    pointer: "",
  };
  catalog.saveWorkflow(check);
  const action = workflow("action");
  action.inputSchema = check.inputSchema;
  action.stages = [action.stages[0]];
  action.stages[0].agents = [action.stages[0].agents[0]];
  action.stages[0].inputs = {};
  action.stages[0].expectedOutput = "A summary of the action.";
  catalog.saveWorkflow(action);
  const calls: AgentRequest[] = [];
  const stageInputs: Json[] = [];
  const control: {
    output: Json;
    before?: (signal: AbortSignal) => Promise<void>;
    lastCommentPostedAt: string | null;
  } = {
    output: plan(),
    lastCommentPostedAt: new Date(Date.now() - 1801000).toISOString(),
  };
  const base = fixtureBackend();
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "stage") stageInputs.push(request.input);
      if (request.purpose === "watch-condition") {
        calls.push(request);
        await control.before?.(signal);
        signal.throwIfAborted();
        return control.output;
      }
      if (
        request.purpose === "stage" &&
        "status" in (request.schema.properties ?? {})
      )
        return {
          status: "ready",
          openCommentCount: 1,
          lastCommentPostedAt: control.lastCommentPostedAt,
        };
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  const inputs = {
    prUrl: { source: "literal" as const, value: "https://example.test/pr/1" },
  };
  const compile = () =>
    host.compileWatchAction(
      "check",
      { workflowId: "action", whenToRun: sentence },
      inputs,
    );
  return {
    root,
    catalog,
    check,
    action,
    backend,
    host,
    calls,
    stageInputs,
    control,
    inputs,
    compile,
    async close() {
      await host.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("compilation uses declared selected output, restricted tools, and automatic matching inputs", async () => {
  const s = setup();
  try {
    const result = await s.compile();
    assert.equal(result.whenToRun, sentence);
    assert.equal(result.workflowId, "action");
    assert.equal(result.recheckSeconds, 600);
    assert.deepEqual(result.conditions, plan().conditions);
    assert.deepEqual(result.inputBindings, {
      prUrl: { source: "input", pointer: "/prUrl" },
    });
    assert.equal(result.deduplicationPointer, undefined);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].allowAllTools, false);
    assert.deepEqual(s.calls[0].allowedFolders, []);
    assert.match(s.calls[0].prompt, /untrusted data/);
    assert.deepEqual(s.calls[0].input, {
      whenToRun: sentence,
      resultSchema: s.check.stages[0].outputSchema,
      resultSchemaRoot: s.check.stages[0].outputSchema,
      operators: [
        "equals",
        "notEquals",
        "greaterThan",
        "greaterThanOrEqual",
        "lessThan",
        "lessThanOrEqual",
        "olderThanSeconds",
      ],
    });
    assert.equal(s.host.store.list().length, 0);
  } finally {
    await s.close();
  }
});

test("unsupported, missing-field, empty and unguarded conditions cannot become runnable rules", async (t) => {
  for (const [label, output, error] of [
    [
      "unsupported",
      {
        status: "unsupported",
        reason: "The result has no suitable new-feedback revision.",
        conditions: [],
        deduplicationPointer: null,
      },
      /no suitable new-feedback revision/,
    ],
    [
      "missing field",
      {
        ...plan(),
        conditions: [{ pointer: "/invented", operator: "equals", value: true }],
      },
      /does not declare field/,
    ],
    ["empty rules", { ...plan(), conditions: [] }, /Too small/],
    [
      "missing null guard",
      { ...plan(), conditions: [plan().conditions[3]] },
      /null guard/,
    ],
    [
      "wrong comparison type",
      {
        ...plan(),
        conditions: [{ pointer: "/status", operator: "greaterThan", value: 1 }],
      },
      /Invalid comparison/,
    ],
    [
      "invented deduplication field",
      { ...plan(), deduplicationPointer: "/revision" },
      /does not declare field/,
    ],
  ] as const) {
    await t.test(label, async () => {
      const s = setup();
      try {
        s.control.output = JSON.parse(JSON.stringify(output));
        await assert.rejects(async () => s.compile(), error);
        assert.deepEqual(s.catalog.watches(), []);
      } finally {
        await s.close();
      }
    });
  }
});

test("required action inputs must be available before invoking AI", async () => {
  const s = setup();
  try {
    s.action.inputSchema = {
      type: "object",
      properties: { repository: { type: "string" } },
      required: ["repository"],
    };
    s.catalog.saveWorkflow(s.action, s.catalog.workflow("action").revision);
    await assert.rejects(async () => s.compile(), /needs "repository"/);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test("compiler supports default final-output arrays and selected nested schemas with local references", async () => {
  const s = setup();
  try {
    delete s.check.result;
    s.catalog.saveWorkflow(s.check, s.catalog.workflow("check").revision);
    s.control.output = {
      ...plan(),
      conditions: plan().conditions.map((condition) => ({
        ...condition,
        pointer: `/0${condition.pointer}`,
      })),
    };
    assert.equal(
      (await s.compile()).conditions.at(-1)!.pointer,
      "/0/lastCommentPostedAt",
    );
    s.check.stages[0].outputSchema = {
      type: "object",
      properties: { payload: { $ref: "#/definitions/payload" } },
      definitions: { payload: s.check.stages[0].outputSchema },
    };
    s.check.result = {
      source: "stage",
      stageId: "discover",
      agentId: "alpha",
      pointer: "/payload",
    };
    s.catalog.saveWorkflow(s.check, s.catalog.workflow("check").revision);
    s.control.output = plan();
    assert.equal(
      (await s.compile()).conditions.at(-1)!.pointer,
      "/lastCommentPostedAt",
    );
  } finally {
    await s.close();
  }
});

test("changed workflows and backend failures prevent a stale or fabricated compiled action", async () => {
  const s = setup();
  try {
    s.control.before = async () => {
      s.action.name = "Changed during compilation";
      s.catalog.saveWorkflow(s.action, s.catalog.workflow("action").revision);
    };
    await assert.rejects(async () => s.compile(), /workflow changed/);
    s.control.before = async () => {
      throw new Error("Backend unavailable");
    };
    await assert.rejects(async () => s.compile(), /Backend unavailable/);
    assert.deepEqual(s.catalog.watches(), []);
  } finally {
    await s.close();
  }
});

test("host shutdown cancels active condition compilation and rejects new work", async () => {
  const s = setup();
  const started = Promise.withResolvers<void>();
  s.control.before = async (signal) => {
    started.resolve();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  try {
    const pending = assert.rejects(s.compile(), /host shutdown/);
    await started.promise;
    await Promise.all([s.host.close(), pending]);
    assert.throws(() => s.compile(), /Host is shutting down/);
  } finally {
    await s.close();
  }
});

test("API compiles once at registration; Pause and scheduled cycles reuse the saved rules", async () => {
  const s = setup();
  let event = 0;
  const watcher = createWatcher(s.root, s.catalog, s.host, [
    {
      id: "change",
      name: "Change",
      description: "",
      settingsSchema: { type: "object" },
      async evaluate() {
        return {
          cursor: ++event,
          candidates: [
            {
              eventId: String(event),
              resourceId: "pr",
              reason: "Check work",
              payload: {},
            },
          ],
        };
      },
    },
  ]);
  const server = createApp(s.catalog, s.host, watcher, s.backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const put = (value: unknown, revision?: string) =>
    fetch(`http://127.0.0.1:${address.port}/api/pipeline-watches/simple`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:4200",
      },
      body: JSON.stringify({ value, revision }),
    });
  try {
    const draft = {
      id: "simple",
      name: "Simple watch",
      workflowId: "check",
      enabled: true,
      policyId: "change",
      settings: {},
      input: "  Check https://example.test/pr/1\nDo not change anything yet.  ",
      cooldownSeconds: 0,
      maxRunsPerHour: 10,
      action: { workflowId: "action", whenToRun: sentence },
    };
    const response = await put(draft);
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    const saved = await response.json();
    assert.deepEqual(saved.value.input, draft.input);
    assert.deepEqual(saved.value.action.input, {
      source: "input",
      pointer: "",
    });
    assert.deepEqual(saved.value.action.inputBindings, {});
    assert.equal(saved.value.action.whenToRun, sentence);
    assert.deepEqual(saved.value.action.conditions, plan().conditions);
    const repeated = await put(draft);
    assert.equal(repeated.status, 409);
    assert.equal(s.calls.length, 1);
    s.control.output = {
      status: "unsupported",
      reason: "Must not recompile.",
      conditions: [],
      deduplicationPointer: null,
    };
    const paused = await put(
      { ...saved.value, enabled: false },
      saved.revision,
    );
    assert.equal(paused.status, 200);
    const pausedWatch = await paused.json();
    await watcher.evaluate(pausedWatch.value);
    assert.deepEqual(s.host.store.list(), []);
    const enabled = await put(saved.value, pausedWatch.revision);
    assert.equal(enabled.status, 200);
    const value: Watch = (await enabled.json()).value;
    const state = await watcher.evaluate(value);
    await waitForRun(() => s.host.store.get(state.activeRunId!));
    const acting = await watcher.evaluate(value);
    assert.equal(acting.phase, "acting");
    await waitForRun(() => s.host.store.get(acting.activeRunId!));
    assert.equal(s.host.store.snapshot(state.activeRunId!).input, draft.input);
    assert.equal(s.host.store.snapshot(acting.activeRunId!).input, draft.input);
    assert.deepEqual(s.stageInputs, [draft.input, draft.input]);
    const completed = await watcher.evaluate(value);
    assert.equal(completed.decisions[0].outcome, "completed");
    s.control.lastCommentPostedAt = null;
    const emptyCheck = await watcher.evaluate(value);
    await waitForRun(() => s.host.store.get(emptyCheck.activeRunId!));
    const skipped = await watcher.evaluate(value);
    assert.equal(skipped.decisions.at(-1)!.outcome, "skipped");
    assert.equal(skipped.error, undefined);
    assert.equal(s.calls.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await s.close();
  }
});

test("API rejects unsupported compilation without registering a watch", async () => {
  const s = setup();
  const watcher = createWatcher(s.root, s.catalog, s.host, [
    {
      id: "change",
      name: "Change",
      description: "",
      settingsSchema: { type: "object" },
      async evaluate() {
        return { cursor: null, candidates: [] };
      },
    },
  ]);
  const server = createApp(s.catalog, s.host, watcher, s.backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  try {
    s.control.output = {
      status: "unsupported",
      reason: "The check has no price field.",
      conditions: [],
      deduplicationPointer: null,
    };
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/pipeline-watches/simple`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:4200",
        },
        body: JSON.stringify({
          value: {
            id: "simple",
            name: "Simple",
            workflowId: "check",
            enabled: true,
            policyId: "change",
            settings: {},
            inputBindings: s.inputs,
            action: {
              workflowId: "action",
              whenToRun: "Run when the price drops.",
            },
          },
        }),
      },
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /no price field/);
    assert.deepEqual(s.catalog.watches(), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await s.close();
  }
});
