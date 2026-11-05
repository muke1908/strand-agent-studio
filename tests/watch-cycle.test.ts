import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost, WorkflowBusyError } from "../server/run-host.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import { createWatcher } from "../server/watcher.ts";
import { createApp } from "../server/app.ts";
import type { WatchPolicy } from "../server/watch-policies.ts";
import { watchSchema } from "../shared/contracts.ts";
import type { Json, WatchDashboardItem } from "../shared/contracts.ts";
import { writeJson } from "../server/files.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";

function setup() {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  for (const id of ["probe", "action"]) {
    const definition = workflow(id);
    definition.stages = [
      {
        ...definition.stages[0],
        name: id === "probe" ? "Probe" : "Act",
        agents: [definition.stages[0].agents[0]],
        outputSchema: { type: "object" },
      },
    ];
    definition.result = {
      source: "stage",
      stageId: "discover",
      agentId: "alpha",
      pointer: "",
    };
    catalog.saveWorkflow(definition);
  }
  const watch = watchSchema.parse({
    id: "cycle",
    name: "Generic work",
    workflowId: "probe",
    enabled: true,
    policyId: "change",
    settings: {},
    inputBindings: { context: { source: "trigger", pointer: "/context" } },
    allowAllTools: true,
    cooldownSeconds: 0,
    maxRunsPerHour: 60,
    action: {
      workflowId: "action",
      conditions: [
        { pointer: "/status", operator: "equals", value: "ready" },
        { pointer: "/count", operator: "greaterThan", value: 0 },
        { pointer: "/lastPostedAt", operator: "olderThanSeconds", value: 1800 },
      ],
      inputBindings: {
        context: { source: "input", pointer: "/context" },
        revision: { source: "trigger", pointer: "/revision" },
        literal: { source: "literal", value: "explicit" },
      },
      deduplicationPointer: "/revision",
      recheckSeconds: 600,
    },
  });
  catalog.saveWatch(watch);
  const control: {
    result: Record<string, Json>;
    failAction: boolean;
    policyCalls: number;
    probeCalls: number;
    actionInputs: Json[];
    policyGate?: Promise<void>;
    probeGate?: Promise<void>;
    actionGate?: Promise<void>;
  } = {
    result: {
      status: "ready",
      count: 1,
      lastPostedAt: "2020-01-01T00:00:00Z",
      revision: "A",
    },
    failAction: false,
    policyCalls: 0,
    probeCalls: 0,
    actionInputs: [],
  };
  const releases: (() => void)[] = [];
  function gate(kind: "policyGate" | "probeGate" | "actionGate") {
    const pending = Promise.withResolvers<void>();
    control[kind] = pending.promise;
    releases.push(pending.resolve);
    return pending;
  }
  const base = fixtureBackend();
  const host = createRunHost(root, catalog, {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "summary")
        return { lines: ["Fixture summary.", "No external actions."] };
      if (request.purpose === "stage") {
        if (request.prompt.includes('Execute stage "Probe"')) {
          control.probeCalls++;
          const result = structuredClone(control.result);
          await control.probeGate;
          signal.throwIfAborted();
          return result;
        }
        control.actionInputs.push(request.input);
        await control.actionGate;
        signal.throwIfAborted();
        if (control.failAction)
          throw new Error("Action failed; retry after a fresh check");
        return { summary: "Handled" };
      }
      return base.execute(request, signal);
    },
  });
  const policy: WatchPolicy = {
    id: "change",
    name: "Change",
    description: "",
    settingsSchema: { type: "object" },
    async evaluate() {
      const event = ++control.policyCalls;
      await control.policyGate;
      return {
        cursor: event,
        candidates: [
          {
            eventId: String(event),
            resourceId: "resource",
            payload: { context: "same resource" },
            reason: "New check",
          },
        ],
      };
    },
  };
  const watcher = createWatcher(root, catalog, host, [policy]);
  async function check() {
    const state = await watcher.evaluate(watch);
    const id = state.decisions.at(-1)!.runId!;
    const run = await waitForRun(() => host.store.get(id));
    assert.equal(run.status, "completed", run.error);
    return run;
  }
  async function close() {
    for (const release of releases) release();
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
  return {
    root,
    catalog,
    watch,
    control,
    gate,
    host,
    policy,
    watcher,
    check,
    close,
  };
}

test("check/action cycles suspend, recover, bind inputs, consume successful revisions and retain new work during actions", async () => {
  const s = setup();
  const pending = s.gate("actionGate");
  try {
    await s.check();
    let state = await s.watcher.evaluate(s.watch);
    assert.equal(state.phase, "acting");
    const id = state.activeRunId!;
    const pinned = s.host.store.snapshot(id);
    assert.deepEqual(pinned.input, {
      context: "same resource",
      revision: "A",
      literal: "explicit",
    });
    assert.equal(pinned.allowAllTools, true);
    for (let index = 0; index < 3; index++) await s.watcher.evaluate(s.watch);
    assert.equal(s.control.policyCalls, 1);
    assert.equal(s.host.store.list().length, 2);
    delete state.decisions[0].action!.runId;
    writeJson(path.join(s.root, "watch-state", "cycle.json"), state);
    const restarted = createWatcher(s.root, s.catalog, s.host, [s.policy]);
    state = await restarted.evaluate(s.watch);
    assert.equal(state.activeRunId, id);
    assert.equal(state.decisions[0].action!.runId, id);
    assert.equal(s.host.store.list().length, 2);

    s.control.result.revision = "B";
    pending.resolve();
    await waitForRun(() => s.host.store.get(id));
    state = await restarted.evaluate(s.watch);
    assert.equal(state.decisions[0].outcome, "completed");
    assert.equal(state.phase, "watching");
    assert(Date.parse(state.nextCheck) - Date.now() > 599000);
    await restarted.tick(new Date(Date.parse(state.nextCheck) - 1));
    assert.equal(s.control.policyCalls, 1);

    await s.check();
    state = await restarted.evaluate(s.watch);
    assert.equal(state.phase, "acting");
    assert.notEqual(state.activeRunId, id);
    await waitForRun(() => s.host.store.get(state.activeRunId!));
    await restarted.evaluate(s.watch);
    await s.check();
    state = await restarted.evaluate(s.watch);
    assert.equal(state.decisions.at(-1)!.outcome, "duplicate");
    assert.equal(
      s.host.store.list().filter((run) => run.workflowId === "action").length,
      2,
    );
  } finally {
    await s.close();
  }
});

test("blocked and cancelled actions automatically allow fresh checks and retries of the same revision", async () => {
  for (const outcome of ["blocked", "cancelled"]) {
    const s = setup();
    try {
      s.control.failAction = outcome === "blocked";
      const pending =
        outcome === "cancelled" ? s.gate("actionGate") : undefined;
      await s.check();
      let state = await s.watcher.evaluate(s.watch);
      const id = state.activeRunId!;
      if (pending) {
        s.host.stop(id);
        pending.resolve();
      }
      const failed = await waitForRun(() => s.host.store.get(id));
      assert.equal(failed.status, outcome);
      state = await s.watcher.evaluate(s.watch);
      assert.equal(state.phase, "watching");
      assert.equal(state.decisions[0].outcome, outcome);
      assert.match(
        state.error!,
        outcome === "blocked" ? /Action failed/ : /cancel/i,
      );
      assert(Date.parse(state.nextCheck) - Date.now() > 599000);
      s.control.failAction = false;
      await s.check();
      state = await s.watcher.evaluate(s.watch);
      assert.equal(state.phase, "acting");
      assert.notEqual(state.activeRunId, id);
      await waitForRun(() => s.host.store.get(state.activeRunId!));
      state = await s.watcher.evaluate(s.watch);
      assert.equal(state.decisions.at(-1)!.outcome, "completed");
      assert.equal(state.error, undefined);
    } finally {
      await s.close();
    }
  }
});

test("manual runs suspend checks and manual Pause wins; all target admissions including Resume and reruns are exclusive", async () => {
  const s = setup();
  try {
    s.control.failAction = true;
    const failed = s.host.launch(
      "action",
      { context: "failed" },
      "failed-manual",
    );
    await waitForRun(() => s.host.store.get(failed.id));
    s.control.failAction = false;
    const pending = s.gate("actionGate");
    const manual = s.host.launch("action", { context: "manual" }, "manual");
    assert.throws(
      () => s.host.launch("action", { context: "other" }, "overlap"),
      WorkflowBusyError,
    );
    assert.throws(() => s.host.resume(failed.id), WorkflowBusyError);
    assert.throws(
      () => s.host.rerun(failed.id, "discover", "overlap-rerun"),
      WorkflowBusyError,
    );
    assert.equal(
      s.host.launch("action", { context: "manual" }, "manual").id,
      manual.id,
    );
    let state = await s.watcher.evaluate(s.watch);
    assert.equal(state.phase, "waiting");
    assert.equal(state.activeRunId, manual.id);
    assert.equal(s.control.policyCalls, 0);
    const saved = s.catalog.watch(s.watch.id);
    s.catalog.saveWatch({ ...saved.value, enabled: false }, saved.revision);
    pending.resolve();
    await waitForRun(() => s.host.store.get(manual.id));
    await s.watcher.evaluate(s.watch);
    await s.watcher.tick(new Date(Date.now() + 3600000));
    assert.equal(s.control.policyCalls, 0);
    assert.equal(s.catalog.watch(s.watch.id).value.enabled, false);
    const paused = s.catalog.watch(s.watch.id);
    s.catalog.saveWatch({ ...paused.value, enabled: true }, paused.revision);
    state = await s.watcher.evaluate(s.watch);
    assert.equal(state.phase, "watching");
    assert(Date.parse(state.nextCheck) - Date.now() > 599000);
    assert.equal(s.control.policyCalls, 0);
    const resumed = s.host.resume(failed.id);
    assert.equal(resumed.id, failed.id);
    assert.throws(
      () => s.host.launch("action", { context: "other" }, "after-resume"),
      WorkflowBusyError,
    );
    await waitForRun(() => s.host.store.get(failed.id));
  } finally {
    await s.close();
  }
});

test("check launches reconcile after a lost state write and busy admission prevents check/action races", async () => {
  const s = setup();
  try {
    await s.check();
    const state = s.watcher.state(s.watch.id);
    state.decisions[0].status = "pending";
    delete state.decisions[0].runId;
    writeJson(path.join(s.root, "watch-state", "cycle.json"), state);
    const pending = s.gate("actionGate");
    let manualId = "";
    const racingHost = {
      ...s.host,
      launch(...args: Parameters<typeof s.host.launch>) {
        if (args[0] === "action" && args[3]?.watchId && !manualId)
          manualId = s.host.launch(
            "action",
            { context: "racing manual" },
            "racing-manual",
          ).id;
        return s.host.launch(...args);
      },
    };
    const restarted = createWatcher(s.root, s.catalog, racingHost, [s.policy]);
    const waiting = await restarted.evaluate(s.watch);
    assert.equal(waiting.decisions[0].status, "launched");
    assert.equal(waiting.decisions[0].outcome, "skipped");
    assert.equal(waiting.phase, "waiting");
    assert.equal(waiting.activeRunId, manualId);
    assert.equal(s.control.policyCalls, 1);
    assert.equal(s.host.store.list().length, 2);
    pending.resolve();
    await waitForRun(() => s.host.store.get(manualId));
    await restarted.evaluate(s.watch);
    assert.equal(
      s.control.policyCalls,
      1,
      "do not replay stale check after busy run",
    );
  } finally {
    await s.close();
  }
});

test("a manual target launch or Pause during policy evaluation prevents a check launch", async () => {
  for (const pause of [false, true]) {
    const s = setup();
    try {
      const policyGate = s.gate("policyGate");
      const actionGate = s.gate("actionGate");
      const evaluating = s.watcher.evaluate(s.watch);
      assert.equal(s.control.policyCalls, 1);
      let manualId: string | undefined;
      if (pause) {
        const saved = s.catalog.watch(s.watch.id);
        s.catalog.saveWatch({ ...saved.value, enabled: false }, saved.revision);
      } else
        manualId = s.host.launch(
          "action",
          { context: "manual" },
          "during-policy",
        ).id;
      policyGate.resolve();
      const state = await evaluating;
      assert.equal(s.control.probeCalls, 0);
      assert.equal(s.host.store.list().length, pause ? 0 : 1);
      if (!pause) {
        assert.equal(state.phase, "waiting");
        assert.equal(state.activeRunId, manualId);
      }
      actionGate.resolve();
    } finally {
      await s.close();
    }
  }
});

test("qualification is strict, short-circuits readiness guards, and surfaces malformed results without launching", async () => {
  const cases: {
    change: Record<string, Json>;
    outcome: string;
    error?: RegExp;
  }[] = [
    {
      change: { status: "waiting", count: null, lastPostedAt: null },
      outcome: "skipped",
    },
    { change: { count: 0 }, outcome: "skipped" },
    {
      change: { lastPostedAt: "not a timestamp" },
      outcome: "error",
      error: /datetime|ISO/i,
    },
    {
      change: { lastPostedAt: "2020-01-01T00:00:00" },
      outcome: "error",
      error: /datetime|ISO/i,
    },
    {
      change: { lastPostedAt: "2099-01-01T00:00:00Z" },
      outcome: "error",
      error: /future timestamp/,
    },
    {
      change: { count: "1" },
      outcome: "error",
      error: /type string; expected number/,
    },
  ];
  for (const entry of cases) {
    const s = setup();
    try {
      Object.assign(s.control.result, entry.change);
      await s.check();
      const state = await s.watcher.evaluate(s.watch);
      assert.equal(state.decisions[0].outcome, entry.outcome);
      if (entry.error) assert.match(state.error!, entry.error);
      else assert.equal(state.error, undefined);
      assert.equal(s.host.store.list().length, 1);
    } finally {
      await s.close();
    }
  }
  for (const age of [1799, 1800, 1801]) {
    const s = setup();
    try {
      const now = new Date();
      s.control.result.lastPostedAt = new Date(
        now.getTime() - age * 1000,
      ).toISOString();
      await s.check();
      const state = await s.watcher.evaluate(s.watch, now);
      assert.equal(state.phase, age > 1800 ? "acting" : "watching");
    } finally {
      await s.close();
    }
  }
});

test("missing bindings, stale checks and registration errors cannot launch actions", async () => {
  const s = setup();
  try {
    const invalidPointer = {
      ...s.watch,
      action: {
        ...s.watch.action!,
        conditions: [
          { pointer: "wrong", operator: "equals" as const, value: true },
        ],
      },
    };
    assert.throws(
      () => s.watcher.validate(invalidPointer),
      /Invalid JSON Pointer/,
    );
    assert.throws(
      () =>
        s.watcher.validate({
          ...s.watch,
          action: {
            ...s.watch.action!,
            conditions: [
              { pointer: "/count", operator: "greaterThan", value: "1" },
            ],
          },
        }),
      /numeric value/,
    );
    assert.throws(
      () =>
        s.watcher.validate({
          ...s.watch,
          action: {
            ...s.watch.action!,
            inputBindings: {
              context: {
                source: "stage",
                stageId: "discover",
                agentId: "alpha",
                pointer: "",
              },
            },
          },
        }),
      /Action inputs/,
    );
    const saved = s.catalog.watch(s.watch.id);
    assert.throws(
      () =>
        s.catalog.saveWatch(
          {
            ...s.watch,
            action: { ...s.watch.action!, recheckSeconds: 60 },
          },
          saved.revision,
        ),
      /Create a new watch/,
    );
    assert.throws(
      () =>
        s.catalog.deleteWorkflow(
          "action",
          s.catalog.workflow("action").revision,
        ),
      /Pause these watches/,
    );

    delete s.control.result.count;
    await s.check();
    let state = await s.watcher.evaluate(s.watch);
    assert.match(state.error!, /Missing binding value/);
    assert.equal(state.decisions[0].outcome, "error");
    s.control.result.count = 1;
    const check = await s.check();
    state = await s.watcher.evaluate(
      s.watch,
      new Date(Date.parse(check.updatedAt) + 600001),
    );
    assert.equal(state.decisions.at(-1)!.outcome, "skipped");
    assert.equal(
      s.host.store.list().filter((run) => run.workflowId === "action").length,
      0,
    );
  } finally {
    await s.close();
  }
});

test("cooldown and hourly budgets are independent for checks and actions", async () => {
  const s = setup();
  try {
    const prior = s.catalog.watch(s.watch.id);
    const watch = { ...s.watch, cooldownSeconds: 60, maxRunsPerHour: 1 };
    s.catalog.saveWatch(watch, prior.revision);
    const check = await s.check();
    let state = await s.watcher.evaluate(watch);
    assert.equal(
      state.phase,
      "acting",
      "the check's cooldown and hourly slot do not prevent its action",
    );
    await waitForRun(() => s.host.store.get(state.activeRunId!));
    await s.watcher.evaluate(watch);
    const now = new Date(Date.parse(check.createdAt) + 1000);
    state = await s.watcher.evaluate(watch, now);
    assert.equal(state.decisions.at(-1)!.status, "pending");
    assert.equal(s.host.store.list().length, 2);
    assert.equal(
      s.host.store.list().filter((run) => run.workflowId === "action").length,
      1,
    );
  } finally {
    await s.close();
  }
});

test("cycle API validates configuration and exposes durable check/action links without overwriting manual Pause", async () => {
  const s = setup();
  const server = createApp(
    s.catalog,
    s.host,
    s.watcher,
    fixtureBackend(),
  ).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const origin = `http://127.0.0.1:${address.port}`;
  const put = (value: unknown) =>
    fetch(`${origin}/api/pipeline-watches/other`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:4200",
      },
      body: JSON.stringify({ value }),
    });
  try {
    const invalid = await put({
      ...s.watch,
      id: "other",
      action: {
        ...s.watch.action!,
        conditions: [{ pointer: "invalid", operator: "equals", value: true }],
      },
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Invalid JSON Pointer/);
    const invalidSource = await put({
      ...s.watch,
      id: "other",
      action: {
        ...s.watch.action!,
        inputBindings: { context: { source: "loop", pointer: "/context" } },
      },
    });
    assert.equal(invalidSource.status, 400);
    const pending = s.gate("actionGate");
    const check = await s.check();
    const acting = await s.watcher.evaluate(s.watch);
    const rows: WatchDashboardItem[] = await (
      await fetch(`${origin}/api/watch-dashboard`)
    ).json();
    assert.equal(rows[0].state.phase, "acting");
    assert.equal(rows[0].latestRun!.id, check.id);
    assert.equal(rows[0].state.decisions[0].action!.runId, acting.activeRunId);
    const saved = s.catalog.watch(s.watch.id);
    const paused = await fetch(`${origin}/api/pipeline-watches/cycle`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:4200",
      },
      body: JSON.stringify({
        value: { ...saved.value, enabled: false },
        revision: saved.revision,
      }),
    });
    assert.equal(paused.status, 200);
    pending.resolve();
    await waitForRun(() => s.host.store.get(acting.activeRunId!));
    await s.watcher.tick(new Date(Date.now() + 3600000));
    assert.equal(s.catalog.watch(s.watch.id).value.enabled, false);
    assert.equal(s.control.policyCalls, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await s.close();
  }
});

test("blocked check runs do not launch actions and resume with a fresh check", async () => {
  const s = setup();
  try {
    s.control.result.status = "blocked";
    let state = await s.watcher.evaluate(s.watch);
    const check = await waitForRun(() =>
      s.host.store.get(state.decisions[0].runId!),
    );
    assert.equal(check.status, "blocked");
    state = await s.watcher.evaluate(s.watch);
    assert.equal(state.decisions[0].outcome, "blocked");
    assert.equal(state.phase, "watching");
    assert.match(state.error!, /reported status "blocked"/);
    s.control.result.status = "ready";
    await s.check();
    state = await s.watcher.evaluate(s.watch);
    assert.equal(state.phase, "acting");
  } finally {
    await s.close();
  }
});

test("revision deduplication ignores object key order, not new feedback", async () => {
  const s = setup();
  try {
    s.control.result.revision = { thread: 1, comment: 2 };
    await s.check();
    let state = await s.watcher.evaluate(s.watch);
    await waitForRun(() => s.host.store.get(state.activeRunId!));
    await s.watcher.evaluate(s.watch);
    s.control.result.revision = { comment: 2, thread: 1 };
    await s.check();
    state = await s.watcher.evaluate(s.watch);
    assert.equal(state.decisions.at(-1)!.outcome, "duplicate");
    s.control.result.revision = { comment: 3, thread: 1 };
    await s.check();
    state = await s.watcher.evaluate(s.watch);
    assert.equal(state.phase, "acting");
  } finally {
    await s.close();
  }
});

test("a failed action completed through manual Resume also consumes its revision", async () => {
  const s = setup();
  try {
    s.control.failAction = true;
    await s.check();
    let state = await s.watcher.evaluate(s.watch);
    const id = state.activeRunId!;
    await waitForRun(() => s.host.store.get(id));
    await s.watcher.evaluate(s.watch);
    s.control.failAction = false;
    s.host.resume(id);
    const completed = await waitForRun(() => s.host.store.get(id));
    assert.equal(completed.status, "completed", completed.error);
    await s.check();
    state = await s.watcher.evaluate(s.watch);
    assert.equal(state.decisions.at(-1)!.outcome, "duplicate");
    assert.equal(
      s.host.store.list().filter((run) => run.workflowId === "action").length,
      1,
    );
  } finally {
    await s.close();
  }
});
