import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import type { AgentBackend } from "../server/agent-backend.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";
import { validateReferences, pointer } from "../shared/bindings.ts";
import { validateExpansion } from "../server/validation.ts";
import { unitDetails } from "../server/unit-details.ts";
import { digest, writeJson } from "../server/files.ts";
import { createRunStore } from "../server/run-store.ts";
import { executeRun } from "../server/run-engine.ts";

test("uncommitted immutable artifacts block every retry before any backend execution", async () => {
  for (const name of [
    "schema-discover.json",
    `output-${digest({ stageId: "discover", agentId: "alpha" })}.json`,
    "output.json",
    "result.json",
  ]) {
    const root = temporaryRoot();
    const store = createRunStore(root);
    const base = fixtureBackend();
    let calls = 0;
    const backend: AgentBackend = {
      ...base,
      async execute(request, signal) {
        calls++;
        return base.execute(request, signal);
      },
    };
    try {
      const run = store.create(
        workflow(),
        [],
        { context: "Recovery" },
        name,
        base.id,
      );
      writeJson(path.join(store.directory(run.id), name), {});
      for (let retry = 0; retry < 2; retry++) {
        await executeRun(store, run.id, backend, new AbortController().signal);
        assert.equal(store.get(run.id).status, "blocked");
        assert.match(store.get(run.id).error!, /Uncommitted artifact/);
        assert.equal(calls, 0, name);
      }
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("recovered artifacts repair interrupted activity without rerunning agents or rewriting failed history", async () => {
  const root = temporaryRoot();
  const store = createRunStore(root);
  const base = fixtureBackend();
  let calls = 0;
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      calls++;
      return base.execute(request, signal);
    },
  };
  try {
    const run = store.create(
      workflow(),
      [],
      { context: "Recovery" },
      "recovered-state",
      base.id,
    );
    await executeRun(store, run.id, backend, new AbortController().signal);
    const interrupted = store.get(run.id);
    for (const unit of Object.values(interrupted.units)) {
      unit.status = "running";
      unit.attempts.at(-1)!.status = "running";
      unit.attempts.unshift({
        id: `old-${unit.stageId}-${unit.agentId}`,
        status: "blocked",
        error: "Earlier failure",
      });
    }
    interrupted.status = "blocked";
    store.save(interrupted);
    calls = 0;
    await executeRun(store, run.id, backend, new AbortController().signal);
    const recovered = store.get(run.id);
    assert.equal(recovered.status, "completed");
    assert.equal(calls, 0);
    for (const unit of Object.values(recovered.units)) {
      assert.equal(unit.status, "completed");
      assert.equal(unit.attempts.at(-1)!.status, "completed");
      assert.equal(unit.attempts[0].status, "blocked");
      assert.equal(unit.attempts[0].error, "Earlier failure");
    }
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("self-contained schema IDs survive repeated saves, launches, edits and resume", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = workflow();
  definition.inputSchema.$id = "urn:strand:input";
  for (const stage of definition.stages)
    stage.outputSchema.$id = "urn:strand:output";
  let host: ReturnType<typeof createRunHost> | undefined;
  try {
    catalog.saveWorkflow(definition);
    host = createRunHost(root, catalog, fixtureBackend());
    const first = host.launch(
      "sample",
      { context: "First" },
      "schema-id-first",
    );
    const second = host.launch(
      "sample",
      { context: "Second" },
      "schema-id-second",
    );
    assert.equal(
      (await waitForRun(() => host!.store.get(first.id))).status,
      "completed",
    );
    assert.equal(
      (await waitForRun(() => host!.store.get(second.id))).status,
      "completed",
    );
    const saved = catalog.workflow("sample");
    catalog.saveWorkflow({ ...saved.value, name: "Edited" }, saved.revision);
    const interrupted = host.store.get(first.id);
    interrupted.status = "blocked";
    host.store.save(interrupted);
    host.resume(first.id);
    assert.equal(
      (await waitForRun(() => host!.store.get(first.id))).status,
      "completed",
    );
    assert.equal(host.store.get(first.id).workflowName, "Sample workflow");
  } finally {
    await host?.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("stage barrier retains all outputs, validates bindings and selects the final result", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  const base = fixtureBackend();
  const observed: string[] = [];
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "stage") {
        observed.push(request.prompt);
        if (request.prompt.includes("Alpha"))
          await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const run = host.launch(
      "sample",
      { context: "Pinned evidence" },
      "request-1",
    );
    const result = await waitForRun(() => host.store.get(run.id));
    assert.equal(result.status, "completed");
    assert.equal(host.store.snapshot(run.id).allowAllTools, false);
    assert.equal(host.store.snapshot(run.id).allowedFolders, undefined);
    assert(observed[2].includes("discover/alpha"));
    assert(observed[2].includes("discover/beta"));
    assert.deepEqual(result.result, [
      { summary: "Fixture output - automated testing only" },
    ]);
    assert.equal(
      host.launch("sample", { context: "Pinned evidence" }, "request-1").id,
      run.id,
    );
    assert.throws(
      () => host.launch("sample", { context: "Changed" }, "request-1"),
      /different input/,
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("failed agents block progression; resume uses pinned skills/input and accepted outputs", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const base = fixtureBackend();
  let fail = true;
  let alphaCalls = 0;
  const permissions: boolean[] = [];
  const grantedFolders: {
    purpose: string;
    prompt: string;
    folders: string[];
  }[] = [];
  const folder = path.join(root, "project with spaces");
  const otherFolder = path.join(root, "another project");
  const alias = path.join(root, "project-link");
  fs.mkdirSync(folder);
  fs.mkdirSync(otherFolder);
  fs.symlinkSync(folder, alias);
  const pinnedFolders = [fs.realpathSync(folder)];
  const alphaFolders = [fs.realpathSync(otherFolder)];
  const definition = workflow();
  definition.stages[0].agents[0].allowedFolders = [otherFolder];
  definition.stages[0].agents[1].allowedFolders = [alias, folder];
  catalog.saveWorkflow(definition);
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      permissions.push(request.allowAllTools ?? false);
      grantedFolders.push({
        purpose: request.purpose,
        prompt: request.prompt,
        folders: request.allowedFolders ?? [],
      });
      if (
        request.purpose === "stage" &&
        request.prompt.includes("You are Alpha")
      )
        alphaCalls++;
      if (
        request.purpose === "stage" &&
        request.prompt.includes("You are Beta") &&
        fail
      )
        throw new Error("Deliberate failure");
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const run = host.launch(
      "sample",
      { context: "Original" },
      "request-fail",
      undefined,
      true,
    );
    const blocked = await waitForRun(() => host.store.get(run.id));
    assert.equal(blocked.status, "blocked");
    assert(!blocked.units["report/writer"]);
    const failedDetails = unitDetails(host.store, run.id, "discover/beta");
    assert.equal(failedDetails.output, undefined);
    assert.equal(failedDetails.unit.attempts[0].error, "Deliberate failure");
    assert.deepEqual(failedDetails.input, {
      stageInstructions: "",
      agentInstructions: "",
      allowedFolders: pinnedFolders,
      skills: [],
      workflowInput: { context: "Original" },
      stageInput: { context: "Original" },
      handoffs: {},
    });
    const current = catalog.workflow("sample");
    catalog.saveWorkflow(
      {
        ...current.value,
        name: "Changed after admission",
        stages: current.value.stages.map((stage) => ({
          ...stage,
          agents: stage.agents.map((agent) =>
            agent.id === "beta"
              ? { ...agent, allowedFolders: [otherFolder] }
              : agent,
          ),
        })),
      },
      current.revision,
    );
    fs.unlinkSync(alias);
    fs.symlinkSync(otherFolder, alias);
    fail = false;
    host.resume(run.id);
    const recovered = await waitForRun(() => host.store.get(run.id));
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.workflowName, "Sample workflow");
    assert.equal(alphaCalls, 1);
    assert.equal(host.store.snapshot(run.id).allowAllTools, true);
    assert(permissions.length > 0 && permissions.every(Boolean));
    assert.deepEqual(
      host.store.snapshot(run.id).workflow.stages[0].agents[1].allowedFolders,
      pinnedFolders,
    );
    assert(grantedFolders.length > 0);
    for (const request of grantedFolders) {
      const expected =
        request.purpose === "schema"
          ? []
          : request.prompt.includes("You are Alpha")
            ? alphaFolders
            : request.prompt.includes("You are Beta")
              ? pinnedFolders
              : [];
      assert.deepEqual(request.folders, expected);
    }
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("historical run-wide folder grants survive execution and remain visible in activity", async () => {
  const root = temporaryRoot();
  const folder = path.join(root, "legacy project");
  fs.mkdirSync(folder);
  const folders = [fs.realpathSync(folder)];
  const id = "legacy-folder-run";
  const directory = path.join(root, "runs", id);
  const snapshot = {
    workflow: workflow(),
    skills: [],
    input: { context: "Historical input" },
    backendId: "test-fixture",
    allowAllTools: false,
    allowedFolders: folders,
  };
  writeJson(path.join(directory, "snapshot.json"), snapshot);
  writeJson(path.join(directory, "manifest.json"), {
    "snapshot.json": digest(snapshot),
  });
  writeJson(path.join(directory, "state.json"), {
    id,
    workflowId: "sample",
    workflowName: "Sample workflow",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requestId: "legacy-request",
    allowedFolders: folders,
    units: {},
  });
  const base = fixtureBackend();
  const observed: string[][] = [];
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      observed.push(request.allowedFolders ?? []);
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, createCatalog(root), backend);
  try {
    assert.equal(
      (await waitForRun(() => host.store.get(id))).status,
      "completed",
    );
    assert(observed.length > 0);
    for (const granted of observed) assert.deepEqual(granted, folders);
    const details = unitDetails(host.store, id, "discover/alpha");
    assert(
      details.input !== null &&
        typeof details.input === "object" &&
        !Array.isArray(details.input),
    );
    assert.deepEqual(details.input.allowedFolders, folders);
    host.store.verify(id);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("tampered artifacts and removed schema constraints fail closed", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  const host = createRunHost(root, catalog, fixtureBackend());
  try {
    const run = host.launch(
      "sample",
      { context: "Evidence" },
      "request-tamper",
    );
    await waitForRun(() => host.store.get(run.id));
    fs.writeFileSync(
      path.join(host.store.directory(run.id), "snapshot.json"),
      "{}",
    );
    assert.throws(() => host.store.verify(run.id), /integrity/);
    assert.throws(
      () => unitDetails(host.store, run.id, "discover/alpha"),
      /integrity/,
    );
    assert.throws(
      () =>
        validateExpansion(
          { type: "object", required: ["evidence"] },
          { type: "object" },
        ),
      /removed/,
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("bindings reject forward references, malformed pointers, and absent optional values", () => {
  const value = workflow();
  value.stages[0].inputs.invalid = {
    source: "stage",
    stageId: "report",
    agentId: "writer",
    pointer: "",
  };
  assert.throws(() => validateReferences(value), /earlier/);
  assert.equal(pointer({ "a/b": { "~key": false } }, "/a~1b/~0key"), false);
  assert.throws(() => pointer({}, "/missing"), /Missing/);
  assert.throws(() => pointer({}, "/~2"), /Invalid/);
});

test("invalid input and optimistic edit conflicts do not launch or overwrite", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const saved = catalog.saveWorkflow(workflow());
  const host = createRunHost(root, catalog, fixtureBackend());
  try {
    assert.throws(() => host.launch("sample", {}, "invalid"), /context/);
    assert.equal(host.store.list().length, 0);
    catalog.saveWorkflow({ ...saved.value, name: "Changed" }, saved.revision);
    assert.throws(
      () => catalog.saveWorkflow(saved.value, saved.revision),
      /changed/,
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});
