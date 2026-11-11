import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AgentBackend, AgentRequest } from "../server/agent-backend.ts";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { createWatcher } from "../server/watcher.ts";
import { createApp } from "../server/app.ts";
import { cronPolicy } from "../server/watch-policies.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import { readWatchSchedule } from "../shared/watch-schedule.ts";
import type { Json, Watch } from "../shared/contracts.ts";
import { temporaryRoot, workflow } from "./helpers.ts";

const sentence = "Every day at 7am and 7 pm";
const timeZone = "Europe/Berlin";
const daily = {
  status: "ready",
  reason: "Two local times every day.",
  description: "Every day at 07:00 and 19:00",
  expressions: ["0 7,19 * * *"],
  intervalMinutes: null,
};

function setup() {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  const calls: AgentRequest[] = [];
  const control: {
    output: Json;
    before?: (signal: AbortSignal) => Promise<void>;
  } = { output: daily };
  const base = fixtureBackend();
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose !== "watch-schedule")
        return base.execute(request, signal);
      calls.push(request);
      await control.before?.(signal);
      signal.throwIfAborted();
      return control.output;
    },
  };
  const host = createRunHost(root, catalog, backend);
  return {
    root,
    catalog,
    calls,
    control,
    backend,
    host,
    compile: () => host.compileWatchSchedule(sentence, timeZone),
    async close() {
      await host.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("LLM-derived calendar timing accepts multiple times and preserves local times across DST", async () => {
  const s = setup();
  try {
    const compiled = await s.compile();
    assert.equal(compiled.schedule, sentence);
    assert.deepEqual(compiled.expressions, ["0 7,19 * * *"]);
    assert.deepEqual(s.calls[0].input, { schedule: sentence, timeZone });
    assert.equal(s.calls[0].allowAllTools, false);
    assert.deepEqual(s.calls[0].allowedFolders, []);
    assert.match(s.calls[0].prompt, /untrusted data/);
    for (const [now, previous, next] of [
      [
        "2026-10-24T05:01:00Z",
        "2026-10-24T05:00:00.000Z",
        "2026-10-24T17:00:00.000Z",
      ],
      [
        "2026-10-24T17:01:00Z",
        "2026-10-24T17:00:00.000Z",
        "2026-10-25T06:00:00.000Z",
      ],
      [
        "2026-10-25T06:01:00Z",
        "2026-10-25T06:00:00.000Z",
        "2026-10-25T18:00:00.000Z",
      ],
    ]) {
      const result = readWatchSchedule(
        { schedule: sentence, timeZone, compiled },
        new Date(now),
      );
      assert.equal(result.previous, previous);
      assert.equal(result.next, next);
    }
    assert.equal(
      s.calls.length,
      1,
      "Reading saved timing must not invoke the LLM again",
    );
    assert.deepEqual(s.host.store.list(), []);
  } finally {
    await s.close();
  }
});

test("compiled unions and fixed intervals keep all occurrences without hour-boundary resets", async () => {
  const s = setup();
  try {
    s.control.output = {
      ...daily,
      description: "Weekdays at 07:00 and weekends at 09:00",
      expressions: ["0 7 * * 1-5", "0 9 * * 0,6"],
    };
    const compiled = await s.host.compileWatchSchedule(
      "Weekdays at 7am and weekends at 9am",
      timeZone,
    );
    const settings = { schedule: compiled.schedule, timeZone, compiled };
    assert.equal(
      readWatchSchedule(settings, new Date("2026-11-06T06:01:00Z")).next,
      "2026-11-07T08:00:00.000Z",
    );
    assert.equal(
      readWatchSchedule(settings, new Date("2026-11-08T08:01:00Z")).next,
      "2026-11-09T06:00:00.000Z",
    );
    for (const minutes of [5, 90]) {
      s.control.output = {
        ...daily,
        description: `Every ${minutes} minutes`,
        expressions: [],
        intervalMinutes: minutes,
      };
      const interval = await s.host.compileWatchSchedule(
        `every ${minutes} min`,
        "UTC",
      );
      const first = readWatchSchedule(
        { schedule: interval.schedule, timeZone: "UTC", compiled: interval },
        new Date("2026-11-08T00:00:01Z"),
      );
      const second = readWatchSchedule(
        { schedule: interval.schedule, timeZone: "UTC", compiled: interval },
        new Date(Date.parse(first.next) + 1),
      );
      assert.equal(second.previous, first.next);
      assert.equal(
        Date.parse(second.next) - Date.parse(first.next),
        minutes * 60000,
      );
    }
  } finally {
    await s.close();
  }
});

test("unsupported or malformed model timing cannot become a runnable schedule", async (t) => {
  for (const [output, error] of [
    [
      {
        ...daily,
        status: "unsupported",
        reason: "Specify which days and times.",
      },
      /Specify which days and times/,
    ],
    [{ ...daily, expressions: ["not cron"] }, /five fields/],
    [{ ...daily, expressions: ["0 25 * * *"] }, /Constraint error/],
    [{ ...daily, intervalMinutes: 5 }, /either a fixed interval or calendar/],
    [{ ...daily, expressions: [] }, /either a fixed interval or calendar/],
    [{ ...daily, expressions: ["*/5 * * * * *"] }, /five fields/],
  ] as const) {
    await t.test(JSON.stringify(output), async () => {
      const s = setup();
      try {
        s.control.output = JSON.parse(JSON.stringify(output));
        await assert.rejects(s.compile(), error);
        assert.deepEqual(s.catalog.watches(), []);
      } finally {
        await s.close();
      }
    });
  }
});

test("host shutdown cancels schedule compilation and prevents new jobs", async () => {
  const s = setup();
  const started = Promise.withResolvers<void>();
  s.control.before = async (signal) => {
    started.resolve();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
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

test("API compiles on save, reuses persisted timing, and does not replace a watch on compilation failure", async () => {
  const s = setup();
  const watcher = createWatcher(s.root, s.catalog, s.host, [cronPolicy]);
  const server = createApp(s.catalog, s.host, watcher, s.backend).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const put = (value: Watch, revision?: string) =>
    fetch(`http://127.0.0.1:${address.port}/api/pipeline-watches/${value.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value, revision }),
    });
  let value: Watch = {
    id: "llm-schedule",
    name: "LLM schedule",
    workflowId: "sample",
    enabled: true,
    policyId: "schedule-cron",
    settings: { schedule: sentence, timeZone },
    input: "unchanged input",
    inputBindings: {},
    cooldownSeconds: 0,
    maxRunsPerHour: 60,
  };
  try {
    const created = await put(value);
    assert.equal(
      created.status,
      200,
      JSON.stringify(await created.clone().json()),
    );
    let saved = await created.json();
    value = saved.value;
    assert.equal(s.calls.length, 1);
    assert.deepEqual(value.settings.compiled, {
      schedule: sentence,
      timeZone,
      description: daily.description,
      expressions: daily.expressions,
      intervalMinutes: null,
    });
    const baseline = await cronPolicy.evaluate(
      value.settings,
      undefined,
      new Date("2026-11-08T06:01:00Z"),
    );
    const evening = await cronPolicy.evaluate(
      value.settings,
      baseline.cursor,
      new Date("2026-11-08T18:01:00Z"),
    );
    assert.equal(evening.candidates[0].eventId, "2026-11-08T18:00:00.000Z");
    assert.equal(
      (
        await cronPolicy.evaluate(
          value.settings,
          evening.cursor,
          new Date("2026-11-08T18:02:00Z"),
        )
      ).candidates.length,
      0,
    );

    const paused = await put(
      {
        ...value,
        enabled: false,
        settings: { ...value.settings, compiled: { bogus: true } },
      },
      saved.revision,
    );
    assert.equal(paused.status, 200);
    saved = await paused.json();
    assert.deepEqual(
      saved.value.settings.compiled,
      value.settings.compiled,
      "Unchanged timing must come from persisted data, not the client",
    );
    assert.equal(s.calls.length, 1);

    s.control.output = {
      ...daily,
      description: "Every 5 minutes",
      expressions: [],
      intervalMinutes: 5,
    };
    const changed = await put(
      { ...saved.value, settings: { schedule: "every 5 min", timeZone } },
      saved.revision,
    );
    assert.equal(changed.status, 200);
    saved = await changed.json();
    assert.equal(saved.value.settings.compiled.intervalMinutes, 5);
    assert.equal(s.calls.length, 2);

    const moved = await put(
      {
        ...saved.value,
        settings: { ...saved.value.settings, timeZone: "America/New_York" },
      },
      saved.revision,
    );
    assert.equal(moved.status, 200);
    saved = await moved.json();
    assert.equal(saved.value.settings.compiled.timeZone, "America/New_York");
    assert.equal(s.calls.length, 3);

    s.control.output = {
      ...daily,
      status: "unsupported",
      reason: "Specify a time.",
    };
    const rejected = await put(
      { ...saved.value, settings: { schedule: "whenever", timeZone } },
      saved.revision,
    );
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /Specify a time/);
    assert.deepEqual(
      s.catalog.watches().find((item) => item.value.id === value.id),
      saved,
    );
    assert.equal(s.calls.length, 4);

    const legacy = {
      ...value,
      id: "legacy",
      settings: { expression: "0 9 * * *", timeZone },
    };
    const legacyResponse = await put(legacy);
    assert.equal(legacyResponse.status, 200);
    assert.equal(s.calls.length, 4);
  } finally {
    await s.host.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await s.close();
  }
});
