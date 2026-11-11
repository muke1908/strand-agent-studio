import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import { createWatcher } from "../server/watcher.ts";
import { cronPolicy } from "../server/watch-policies.ts";
import type { WatchPolicy } from "../server/watch-policies.ts";
import { watchSchema } from "../shared/contracts.ts";
import type { Json, Watch } from "../shared/contracts.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";
import { readWatchSchedule } from "../shared/watch-schedule.ts";

test("natural-language schedules resolve intervals and local calendar times", () => {
  const now = new Date("2026-11-08T05:00:01Z");
  for (const schedule of ["every 15 min", "Every 15 minutes"]) {
    const result = readWatchSchedule(
      { schedule, timeZone: "Europe/Berlin" },
      now,
    );
    assert.equal(result.previous, "2026-11-08T05:00:00.000Z");
    assert.equal(result.next, "2026-11-08T05:15:00.000Z");
  }
  for (const schedule of [
    "everyday 7am in the morning",
    "every day at 7am",
    "daily 07:00",
  ]) {
    const result = readWatchSchedule(
      { schedule, timeZone: "Europe/Berlin" },
      now,
    );
    assert.equal(result.next, "2026-11-08T06:00:00.000Z");
  }
  assert.equal(
    readWatchSchedule(
      { schedule: "every weekday at 9am", timeZone: "Europe/Berlin" },
      now,
    ).next,
    "2026-11-09T08:00:00.000Z",
  );
  assert.equal(
    readWatchSchedule(
      { schedule: "every Monday at noon", timeZone: "Europe/Berlin" },
      now,
    ).next,
    "2026-11-09T11:00:00.000Z",
  );
  const dst = readWatchSchedule(
    { schedule: "every day at 7am", timeZone: "America/New_York" },
    new Date("2026-10-31T12:00:01Z"),
  );
  assert.equal(dst.previous, "2026-10-31T11:00:00.000Z");
  assert.equal(dst.next, "2026-11-01T12:00:00.000Z");
});

test("fixed intervals do not reset at hour boundaries and invalid phrases are rejected", () => {
  const settings = { schedule: "every 90 min", timeZone: "UTC" };
  const first = readWatchSchedule(settings, new Date("2026-11-08T00:00:01Z"));
  assert.equal(first.next, "2026-11-08T01:30:00.000Z");
  const second = readWatchSchedule(settings, new Date("2026-11-08T01:30:01Z"));
  assert.equal(second.previous, first.next);
  assert.equal(second.next, "2026-11-08T03:00:00.000Z");
  for (const schedule of [
    "",
    "sometimes",
    "every 0 min",
    "every day at 7",
    "every day at 25:00",
    "every day at 7pm in the morning",
    "*/15 * * * *",
  ]) {
    assert.throws(() => readWatchSchedule({ schedule, timeZone: "UTC" }));
  }
  assert.throws(() =>
    readWatchSchedule({ schedule: "every hour", timeZone: "invalid" }),
  );
});

test("natural-language registrations validate and trigger once per scheduled interval", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  const host = createRunHost(root, catalog, fixtureBackend());
  const watcher = createWatcher(root, catalog, host, [cronPolicy]);
  const watch: Watch = {
    ...registration,
    policyId: "schedule-cron",
    settings: { schedule: "every 15 min", timeZone: "Europe/Berlin" },
    inputBindings: { context: { source: "literal", value: "Scheduled check" } },
  };
  try {
    watcher.validate(watch);
    assert.throws(() =>
      watcher.validate({
        ...watch,
        settings: { schedule: "whenever", timeZone: "UTC" },
      }),
    );
    const baseline = await cronPolicy.evaluate(
      watch.settings,
      undefined,
      new Date("2026-11-08T05:01:00Z"),
    );
    const next = await cronPolicy.evaluate(
      watch.settings,
      baseline.cursor,
      new Date("2026-11-08T05:15:01Z"),
    );
    assert.equal(next.candidates[0].eventId, "2026-11-08T05:15:00.000Z");
    const same = await cronPolicy.evaluate(
      watch.settings,
      next.cursor,
      new Date("2026-11-08T05:16:00Z"),
    );
    assert.equal(same.candidates.length, 0);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

const registration: Watch = {
  id: "watch",
  name: "Watch sample",
  workflowId: "sample",
  enabled: true,
  policyId: "change",
  settings: {},
  inputBindings: { context: { source: "trigger", pointer: "/context" } },
  cooldownSeconds: 0,
  maxRunsPerHour: 10,
};

test("scheduled inputs reach the selected workflow unchanged, including non-object JSON", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = workflow();
  definition.inputSchema = {};
  definition.stages = [definition.stages[0]];
  definition.stages[0].expectedOutput = "A summary of the input.";
  definition.stages[0].agents = [definition.stages[0].agents[0]];
  catalog.saveWorkflow(definition);
  const fixture = fixtureBackend();
  const received: Json[] = [];
  const host = createRunHost(root, catalog, {
    ...fixture,
    async execute(request, signal) {
      if (request.purpose === "stage") received.push(request.input);
      return fixture.execute(request, signal);
    },
  });
  const watcher = createWatcher(root, catalog, host, [cronPolicy]);
  const inputs: Json[] = [
    { nested: { source: "trigger", pointer: "/missing" }, items: [1, false] },
    ["one", { two: 2 }],
    "plain text",
    0,
    false,
    null,
  ];
  try {
    for (const [index, input] of inputs.entries()) {
      const watch = watchSchema.parse({
        ...registration,
        id: `direct-${index}`,
        policyId: "schedule-cron",
        settings: { schedule: "every 15 min", timeZone: "UTC" },
        input,
        inputBindings: undefined,
      });
      watcher.validate(watch);
      catalog.saveWatch(watch);
      await watcher.evaluate(watch, new Date("2026-11-08T05:01:00Z"));
      const state = await watcher.evaluate(
        watch,
        new Date("2026-11-08T05:15:01Z"),
      );
      const decision = state.decisions[0];
      assert.equal(decision.status, "launched", state.error);
      assert.deepEqual(decision.input, input);
      assert.deepEqual(host.store.snapshot(decision.runId!).input, input);
      const run = await waitForRun(() => host.store.get(decision.runId!));
      assert.equal(run.status, "completed", run.error);
    }
    assert.deepEqual(received, inputs);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("watch text bypasses input schemas for actions, workflows and retries, but manual launches still validate", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const fixture = fixtureBackend();
  const received: Json[] = [];
  const host = createRunHost(root, catalog, {
    ...fixture,
    async execute(request, signal) {
      if (request.purpose === "stage" && typeof request.input === "string")
        received.push(request.input);
      return fixture.execute(request, signal);
    },
  });
  const watcher = createWatcher(root, catalog, host, [cronPolicy]);
  const inputs = ["  Review this repository.\n{not JSON}\n  ", ""];
  try {
    for (const [index, input] of inputs.entries()) {
      const definition = workflow(`text-${index}`);
      if (index === 0) definition.stages = [definition.stages[0]];
      for (const stage of definition.stages) {
        stage.expectedOutput = "A summary of the input.";
        stage.agents = [stage.agents[0]];
      }
      catalog.saveWorkflow(definition);
      assert.throws(() => host.launch(definition.id, input, `manual-${index}`));
      const watch = watchSchema.parse({
        ...registration,
        id: definition.id,
        workflowId: definition.id,
        policyId: "schedule-cron",
        settings: { schedule: "every 15 min", timeZone: "UTC" },
        input,
        inputBindings: undefined,
      });
      watcher.validate(watch);
      catalog.saveWatch(watch);
      await watcher.evaluate(watch, new Date("2026-11-08T05:01:00Z"));
      const state = await watcher.evaluate(
        watch,
        new Date("2026-11-08T05:15:01Z"),
      );
      assert.equal(state.decisions[0].status, "launched", state.error);
      const id = state.decisions[0].runId!;
      assert.deepEqual(host.store.snapshot(id).input, input);
      assert.equal(
        (await waitForRun(() => host.store.get(id))).status,
        "completed",
      );
      const retry = host.rerun(id, definition.stages[0].id, `retry-${index}`);
      assert.equal(host.store.snapshot(retry.id).input, input);
      assert.equal(
        (await waitForRun(() => host.store.get(retry.id))).status,
        "completed",
      );
    }
    assert.deepEqual(
      received,
      inputs.flatMap((input) => [input, input]),
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("structured watch inputs still validate and cannot also use bindings", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  const host = createRunHost(root, catalog, fixtureBackend());
  const watcher = createWatcher(root, catalog, host, [cronPolicy]);
  const watch = watchSchema.parse({
    ...registration,
    policyId: "schedule-cron",
    settings: { schedule: "every hour", timeZone: "UTC" },
    input: { context: "Scheduled check" },
    inputBindings: undefined,
  });
  try {
    watcher.validate(watch);
    for (const input of [{}, { context: 42 }, null])
      assert.throws(() => watcher.validate({ ...watch, input }));
    assert.throws(
      () =>
        watcher.validate({
          ...watch,
          inputBindings: registration.inputBindings,
        }),
      /either input or input bindings/,
    );
    const saved = catalog.saveWatch(watch);
    const paused = catalog.saveWatch(
      { ...saved.value, enabled: false },
      saved.revision,
    );
    assert.deepEqual(paused.value.input, watch.input);
    assert.throws(
      () =>
        catalog.saveWatch(
          { ...paused.value, input: { context: "Different input" } },
          paused.revision,
        ),
      /Create a new watch/,
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("baseline does not launch, changed events create new runs once and survive watcher restart", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  catalog.saveWatch(registration);
  const host = createRunHost(root, catalog, fixtureBackend());
  let head = "A";
  const policy: WatchPolicy = {
    id: "change",
    name: "Change",
    description: "",
    settingsSchema: { type: "object" },
    async evaluate(_settings, cursor) {
      return {
        cursor: head,
        candidates:
          cursor !== undefined && cursor !== head
            ? [
                {
                  eventId: head,
                  resourceId: "resource",
                  payload: { context: head },
                  reason: `Head ${head}`,
                },
              ]
            : [],
      };
    },
  };
  try {
    const watcher = createWatcher(root, catalog, host, [policy]);
    await watcher.evaluate(registration);
    assert.equal(host.store.list().length, 0);
    head = "B";
    const triggered = await watcher.evaluate(registration);
    assert.equal(triggered.decisions[0].status, "launched");
    const run = host.store.list()[0];
    await waitForRun(() => host.store.get(run.id));
    const restarted = createWatcher(root, catalog, host, [policy]);
    await restarted.evaluate(registration);
    assert.equal(host.store.list().length, 1);
    assert.equal(host.store.get(run.id).trigger?.eventId, "B");
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("watch failures retain their cursor, disabled watches do not evaluate", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  catalog.saveWatch(registration);
  const host = createRunHost(root, catalog, fixtureBackend());
  let failed = false;
  let calls = 0;
  const policy: WatchPolicy = {
    id: "change",
    name: "Change",
    description: "",
    settingsSchema: { type: "object" },
    async evaluate() {
      calls++;
      if (failed) throw new Error("Provider unavailable");
      return { cursor: "A", candidates: [] };
    },
  };
  try {
    const watcher = createWatcher(root, catalog, host, [policy]);
    await watcher.evaluate(registration);
    failed = true;
    const state = await watcher.evaluate(registration);
    assert.equal(state.cursor, "A");
    assert.match(state.error!, /Provider unavailable/);
    const paused = catalog.saveWatch(
      { ...registration, enabled: false },
      catalog.watch(registration.id).revision,
    );
    await watcher.evaluate(paused.value);
    assert.equal(calls, 2);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("calendar policy coalesces missed occurrences and honors explicit time zones", async () => {
  const settings = { expression: "0 9 * * 1-5", timeZone: "America/New_York" };
  const baseline = await cronPolicy.evaluate(
    settings,
    undefined,
    new Date("2026-10-30T15:00:00Z"),
  );
  assert.equal(baseline.candidates.length, 0);
  const later = await cronPolicy.evaluate(
    settings,
    baseline.cursor,
    new Date("2026-11-02T16:00:00Z"),
  );
  assert.equal(later.candidates.length, 1);
  assert.equal(later.candidates[0].eventId, "2026-11-02T14:00:00.000Z");
});

test("five-minute schedules trigger once per interval, not at every policy check", async () => {
  const settings = { expression: "*/5 * * * *", timeZone: "UTC" };
  const baseline = await cronPolicy.evaluate(
    settings,
    undefined,
    new Date("2026-11-03T17:01:00Z"),
  );
  assert.equal(baseline.candidates.length, 0);
  const first = await cronPolicy.evaluate(
    settings,
    baseline.cursor,
    new Date("2026-11-03T17:05:01Z"),
  );
  assert.equal(first.candidates[0].eventId, "2026-11-03T17:05:00.000Z");
  const same = await cronPolicy.evaluate(
    settings,
    first.cursor,
    new Date("2026-11-03T17:06:01Z"),
  );
  assert.equal(same.candidates.length, 0);
  const next = await cronPolicy.evaluate(
    settings,
    same.cursor,
    new Date("2026-11-03T17:10:01Z"),
  );
  assert.equal(next.candidates[0].eventId, "2026-11-03T17:10:00.000Z");
});

test("scheduled tool access defaults off and follows the latest saved opt-in", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  catalog.saveWatch(registration);
  const host = createRunHost(root, catalog, fixtureBackend());
  let event = 0;
  const policy: WatchPolicy = {
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
            resourceId: "resource",
            payload: { context: "Count PRs" },
            reason: "Changed",
          },
        ],
      };
    },
  };
  try {
    const watcher = createWatcher(root, catalog, host, [policy]);
    for (const allowAllTools of [undefined, true, false]) {
      if (allowAllTools !== undefined) {
        const saved = catalog.watch(registration.id);
        catalog.saveWatch({ ...saved.value, allowAllTools }, saved.revision);
      }
      const state = await watcher.evaluate(registration);
      const run = await waitForRun(() =>
        host.store.get(state.decisions.at(-1)!.runId!),
      );
      assert.equal(run.status, "completed", run.error);
      assert.equal(run.allowAllTools, allowAllTools ?? false);
      assert.equal(
        host.store.snapshot(run.id).allowAllTools,
        allowAllTools ?? false,
      );
    }
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("busy workflows queue only the latest change and apply the hourly admission budget", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  const base = fixtureBackend();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = {
    ...base,
    async execute(
      request: Parameters<typeof base.execute>[0],
      signal: AbortSignal,
    ) {
      if (request.purpose === "stage") await gate;
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  let head = "A";
  const policy: WatchPolicy = {
    id: "change",
    name: "Change",
    description: "",
    settingsSchema: { type: "object" },
    async evaluate(_settings, cursor) {
      return {
        cursor: head,
        candidates:
          cursor !== undefined && cursor !== head
            ? [
                {
                  eventId: head,
                  resourceId: "resource",
                  payload: { context: head },
                  reason: head,
                },
              ]
            : [],
      };
    },
  };
  const watch = { ...registration, maxRunsPerHour: 1 };
  catalog.saveWatch(watch);
  try {
    const watcher = createWatcher(root, catalog, host, [policy]);
    const manual = host.launch("sample", { context: "Manual" }, "manual-busy");
    await watcher.evaluate(watch);
    head = "B";
    await watcher.evaluate(watch);
    head = "C";
    const queued = await watcher.evaluate(watch);
    assert.equal(queued.decisions[0].status, "superseded");
    assert.equal(queued.decisions[1].status, "pending");
    release();
    await waitForRun(() => host.store.get(manual.id));
    const launched = await watcher.evaluate(watch);
    assert.equal(launched.decisions[1].status, "launched");
    await waitForRun(() => host.store.get(launched.decisions[1].runId!));
    head = "D";
    const limited = await watcher.evaluate(watch);
    assert.equal(limited.decisions[2].status, "pending");
    assert.equal(host.store.list().length, 2);
  } finally {
    release();
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("watch submissions inherit serial scheduling and skip a target that is pending or active", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = { ...workflow(), queued: true };
  catalog.saveWorkflow(definition);
  catalog.saveWorkflow({ ...definition, id: "blocker" });
  catalog.saveWatch(registration);
  const base = fixtureBackend();
  const release = Promise.withResolvers<void>();
  const targetStarted = Promise.withResolvers<void>();
  const releaseTarget = Promise.withResolvers<void>();
  const host = createRunHost(root, catalog, {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "stage") {
        await release.promise;
        if (
          request.input &&
          typeof request.input === "object" &&
          !Array.isArray(request.input) &&
          request.input.context === "1"
        ) {
          targetStarted.resolve();
          await releaseTarget.promise;
        }
      }
      return base.execute(request, signal);
    },
  });
  let event = 0;
  const policy: WatchPolicy = {
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
            resourceId: "resource",
            payload: { context: String(event) },
            reason: "Changed",
          },
        ],
      };
    },
  };
  try {
    const watcher = createWatcher(root, catalog, host, [policy]);
    const blocker = host.launch(
      "blocker",
      { context: "Manual run" },
      "blocker",
    );
    const launched = await watcher.evaluate(registration);
    const id = launched.decisions[0].runId!;
    assert.equal(host.store.get(id).queued, true);
    assert.equal(host.store.get(id).status, "queued");
    await watcher.evaluate(registration);
    assert.equal(host.store.list().length, 2);
    host.stop(blocker.id);
    release.resolve();
    await waitForRun(() => host.store.get(blocker.id));
    await targetStarted.promise;
    assert.equal(host.store.get(id).status, "running");
    await watcher.evaluate(registration);
    assert.equal(host.store.list().length, 2);
    releaseTarget.resolve();
    assert.equal(
      (await waitForRun(() => host.store.get(id))).status,
      "completed",
    );
  } finally {
    release.resolve();
    releaseTarget.resolve();
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("dispatch honors pause and limit edits made while provider evaluation is pending", async () => {
  for (const edit of ["pause", "limit"]) {
    const root = temporaryRoot();
    const catalog = createCatalog(root);
    catalog.saveWorkflow(workflow());
    catalog.saveWatch(registration);
    const host = createRunHost(root, catalog, fixtureBackend());
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let changed = false;
    const policy: WatchPolicy = {
      id: "change",
      name: "Change",
      description: "",
      settingsSchema: { type: "object" },
      async evaluate() {
        if (changed) {
          started.resolve();
          await release.promise;
        }
        return {
          cursor: changed ? "B" : "A",
          candidates: changed
            ? [
                {
                  eventId: "B",
                  resourceId: "resource",
                  payload: { context: "B" },
                  reason: "Changed",
                },
              ]
            : [],
        };
      },
    };
    try {
      const watcher = createWatcher(root, catalog, host, [policy]);
      await watcher.evaluate(registration);
      if (edit === "limit") {
        const prior = host.launch(
          "sample",
          { context: "Prior" },
          "prior-watch-run",
          {
            watchId: "watch",
            eventId: "prior",
            reason: "Earlier event",
          },
        );
        await waitForRun(() => host.store.get(prior.id));
      }
      changed = true;
      const evaluating = watcher.evaluate(registration);
      await started.promise;
      const saved = catalog.watches()[0];
      catalog.saveWatch(
        {
          ...saved.value,
          ...(edit === "pause" ? { enabled: false } : { maxRunsPerHour: 1 }),
        },
        saved.revision,
      );
      release.resolve();
      const state = await evaluating;
      assert.equal(state.cursor, "B");
      assert.equal(state.decisions[0].status, "pending");
      assert.equal(host.store.list().length, edit === "pause" ? 0 : 1);
    } finally {
      release.resolve();
      await host.close();
      fs.rmSync(root, { recursive: true });
    }
  }
});
