import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { createWatcher } from "../server/watcher.ts";
import { createApp } from "../server/app.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";

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
  definition.stages[1].instructions = "Summarize only verified evidence.";
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
      stageInstructions: "Summarize only verified evidence.",
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
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(root, { recursive: true });
  }
});
