import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { watchSchema } from "../shared/contracts.ts";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import { seedCatalog } from "../server/starter-workflows.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";

test("deletion protects edits and enabled watches, preserves queued runs, and survives restart", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const saved = catalog.saveWorkflow(workflow());
  const host = createRunHost(root, catalog, fixtureBackend());
  try {
    assert.throws(() => catalog.deleteWorkflow("sample", "stale"), /changed/);
    const watch = catalog.saveWatch(
      watchSchema.parse({
        id: "schedule",
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
    assert.throws(
      () => catalog.deleteWorkflow("sample", saved.revision),
      /Pause.*Daily sample/,
    );
    assert.equal(catalog.workflow("sample").revision, saved.revision);
    catalog.saveWatch({ ...watch.value, enabled: false }, watch.revision);
    const run = host.launch(
      "sample",
      { context: "Keep this run" },
      "delete-run",
    );
    catalog.deleteWorkflow("sample", saved.revision);
    assert.throws(() => catalog.workflow("sample"), /Not found/);
    assert.equal(
      (await waitForRun(() => host.store.get(run.id))).status,
      "completed",
    );
    host.store.verify(run.id);
    assert.deepEqual(host.store.snapshot(run.id).input, {
      context: "Keep this run",
    });
    assert.equal(host.store.get(run.id).workflowName, "Sample workflow");
    const reopened = createCatalog(root);
    seedCatalog(reopened);
    assert.equal(reopened.workflows().length, 0);
    assert.equal(reopened.watches().length, 1);
    assert.equal(reopened.watches()[0].value.enabled, false);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});
