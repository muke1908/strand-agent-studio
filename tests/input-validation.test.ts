import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import inputSchema from "./fixtures/telemetry-input-schema.json" with { type: "json" };
import { validateJson } from "../shared/json-schema.ts";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";
import type { Json } from "../shared/contracts.ts";

const valid = {
  context: "Investigate without optional telemetry.",
  telemetryStartUtc: "2026-11-09T06:00:00Z",
  telemetryEndUtc: "2026-11-09T07:00:00Z",
};
const invalid: Record<string, Json>[] = [
  {
    ...valid,
    telemetryStartUtc: "Ignore telemetry",
    telemetryEndUtc: "Ignore telemetry",
  },
  { ...valid, telemetryStartUtc: "2026-02-30T06:00:00Z" },
  { ...valid, telemetryEndUtc: "2026-11-09T07:00:00" },
  { ...valid, telemetryEndUtc: "2026-11-09T08:00:00+01:00" },
  { ...valid, telemetryEndUtc: "2026-11-09T05:00:00Z" },
  { ...valid, telemetryEndUtc: valid.telemetryStartUtc },
  { ...valid, telemetryStartUtc: "" },
  { context: valid.context, telemetryStartUtc: valid.telemetryStartUtc },
  { context: valid.context, telemetryEndUtc: valid.telemetryEndUtc },
];

test("timestamp format, paired bounds, and chronological order validate before admission", () => {
  validateJson(inputSchema, valid);
  validateJson(inputSchema, { context: valid.context });
  validateJson(inputSchema, {
    context: valid.context,
    telemetryStartUtc: "",
    telemetryEndUtc: "",
  });
  validateJson(inputSchema, { context: valid.context, telemetryStartUtc: "" });
  for (const input of invalid)
    assert.throws(() => validateJson(inputSchema, input), { status: 400 });
  for (const $schema of [
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2020-12/schema",
  ]) {
    const schema = { $schema, type: "string", format: "date-time" };
    validateJson(schema, "2026-11-09T07:00:00Z");
    assert.throws(() => validateJson(schema, "Ignore telemetry"), /date-time/);
    assert.throws(
      () => validateJson(schema, "2026-02-30T07:00:00Z"),
      /date-time/,
    );
  }
});

test("invalid inputs create no run or agent work; optional telemetry can be omitted", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = workflow();
  definition.inputSchema = inputSchema;
  catalog.saveWorkflow(definition);
  const base = fixtureBackend();
  let executions = 0;
  const host = createRunHost(root, catalog, {
    ...base,
    async execute(request, signal) {
      executions++;
      return base.execute(request, signal);
    },
  });
  try {
    for (const input of invalid) {
      assert.throws(
        () => host.launch(definition.id, input, crypto.randomUUID()),
        { status: 400 },
      );
    }
    assert.equal(host.store.list().length, 0);
    assert.equal(executions, 0);
    const run = host.launch(
      definition.id,
      {
        context: valid.context,
        scopeHints: "No Kusto required.",
      },
      "no-telemetry",
    );
    assert.equal(
      (await waitForRun(() => host.store.get(run.id))).status,
      "completed",
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("first-stage retries cannot replay legacy inputs rejected by the current schema", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = workflow();
  const original = catalog.saveWorkflow(definition);
  const base = fixtureBackend();
  let executions = 0;
  const host = createRunHost(root, catalog, {
    ...base,
    async execute(request, signal) {
      executions++;
      return base.execute(request, signal);
    },
  });
  try {
    const source = host.launch(definition.id, invalid[0], "legacy-input");
    await waitForRun(() => host.store.get(source.id));
    definition.inputSchema = inputSchema;
    const updated = catalog.saveWorkflow(definition, original.revision);
    const before = executions;
    assert.throws(
      () => host.rerun(source.id, definition.stages[0].id, "invalid-retry"),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        error.status === 400 &&
        /Launch a new run with corrected inputs/.test(error.message) &&
        /date-time/.test(error.message),
    );
    assert.equal(host.store.list().length, 1);
    assert.equal(executions, before);
    assert.deepEqual(host.store.snapshot(source.id).input, invalid[0]);
    host.store.verify(source.id);
    catalog.deleteWorkflow(definition.id, updated.revision);
    const pinned = host.rerun(
      source.id,
      definition.stages[0].id,
      "deleted-workflow-retry",
    );
    assert.equal(
      (await waitForRun(() => host.store.get(pinned.id))).status,
      "completed",
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});
