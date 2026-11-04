import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import { createWatcher } from "../server/watcher.ts";
import { cronPolicy } from "../server/watch-policies.ts";
import type { WatchPolicy } from "../server/watch-policies.ts";
import type { Watch } from "../shared/contracts.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";

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
    await watcher.evaluate({ ...registration, enabled: false });
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
