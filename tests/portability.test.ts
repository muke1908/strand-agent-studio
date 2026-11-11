import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pathConfig, resolvePathReferences } from "../server/path-config.ts";
import { createCatalog } from "../server/catalog.ts";
import { importWorkflowRepository } from "../server/workflow-import.ts";
import { createRunHost } from "../server/run-host.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import type { AgentRequest } from "../server/agent-backend.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";

function library(root: string) {
  const directory = path.join(root, "library with spaces");
  const base = path.join(directory, "workflows", "sample");
  fs.mkdirSync(path.join(base, "mds"), { recursive: true });
  const definition = workflow();
  for (const stage of definition.stages) {
    stage.outputSchema.properties = {
      ...(stage.outputSchema.properties as object),
      workspace: { const: "${STRAND_PATH_CHECKOUT}" },
    };
    for (const agent of stage.agents) {
      agent.instructionsFile = "mds/work.md";
      agent.instructions = "Old inline instructions";
    }
  }
  fs.writeFileSync(
    path.join(base, "workflow.json"),
    JSON.stringify(definition),
  );
  fs.writeFileSync(
    path.join(base, "mds/work.md"),
    "Call get_path for CHECKOUT before inspecting the workspace.",
  );
  function file(relative: string) {
    return {
      file: relative,
      sha256: createHash("sha256")
        .update(fs.readFileSync(path.join(directory, relative)))
        .digest("hex"),
    };
  }
  fs.writeFileSync(
    path.join(directory, "export.json"),
    JSON.stringify({
      formatVersion: 1,
      workflows: [
        {
          ...file("workflows/sample/workflow.json"),
          id: "sample",
          revision: "original",
          instructionFiles: [file("workflows/sample/mds/work.md")],
        },
      ],
      skills: [],
    }),
  );
  const checkout = path.join(root, "checkout with spaces");
  fs.mkdirSync(checkout);
  const config = pathConfig({
    STRAND_WORKFLOWS_DIR: directory,
    STRAND_PATH_CHECKOUT: checkout,
    ADO_PAT: "not-a-path",
  });
  function writeDefinition(value: unknown) {
    fs.writeFileSync(path.join(base, "workflow.json"), JSON.stringify(value));
    const manifestFile = path.join(directory, "export.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.workflows[0].sha256 = file(
      "workflows/sample/workflow.json",
    ).sha256;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  }
  return {
    directory,
    base,
    definition,
    checkout: fs.realpathSync(checkout),
    config,
    writeDefinition,
  };
}

test("named path configuration excludes credentials and rejects missing or relative paths", () => {
  const root = temporaryRoot();
  try {
    assert.deepEqual(
      pathConfig({ STRAND_PATH_CHECKOUT: root, ADO_PAT: "secret" }).paths,
      { CHECKOUT: fs.realpathSync(root) },
    );
    assert.throws(
      () => pathConfig({ STRAND_PATH_CHECKOUT: "relative" }),
      /absolute/,
    );
    assert.throws(
      () => pathConfig({ STRAND_PATH_CHECKOUT: path.join(root, "missing") }),
      /Cannot access/,
    );
    assert.throws(
      () => resolvePathReferences({ const: "${STRAND_PATH_MISSING}" }, {}),
      /Missing configured path/,
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("initial repository import resolves relative Markdown and schema paths without launching; refresh protects local edits", async () => {
  const root = temporaryRoot();
  try {
    const source = library(root);
    const data = path.join(root, "data");
    const catalog = createCatalog(data, source.config);
    assert.equal(await importWorkflowRepository(catalog, data), 1);
    assert.equal(
      catalog.workflow("sample").value.stages[0].agents[0].instructionsFile,
      "mds/work.md",
    );
    const resolved = catalog.runtimeWorkflow(catalog.workflow("sample").value);
    assert.equal(
      resolved.stages[0].agents[0].instructionsFile,
      path.join(fs.realpathSync(source.base), "mds/work.md"),
    );
    assert.match(resolved.stages[0].agents[0].instructions, /Call get_path/);
    assert.deepEqual(resolved.stages[0].outputSchema.properties, {
      summary: { type: "string" },
      workspace: { const: source.checkout },
    });
    assert.equal(fs.existsSync(path.join(data, "runs")), false);
    assert.equal(await importWorkflowRepository(catalog, data), 0);
    const saved = catalog.workflow("sample");
    catalog.saveWorkflow(
      { ...saved.value, name: "Owner edit" },
      saved.revision,
    );
    await assert.rejects(
      () => importWorkflowRepository(catalog, data, true),
      /Local workflows\/sample changed/,
    );
    assert.equal(catalog.workflow("sample").value.name, "Owner edit");
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("repository imports compile natural-language inputs and reuse unchanged compiled schemas on refresh", async () => {
  const root = temporaryRoot();
  try {
    const source = library(root);
    const definition = {
      ...source.definition,
      expectedInput: "Require a nonempty string context.",
      inputSchema: undefined,
    };
    source.writeDefinition(definition);
    const data = path.join(root, "data");
    const catalog = createCatalog(data, source.config);
    const requests: AgentRequest[] = [];
    const backend = {
      ...fixtureBackend(),
      async execute(request: AgentRequest) {
        requests.push(request);
        assert.equal(request.purpose, "schema");
        assert.equal(request.allowAllTools, false);
        assert.deepEqual(request.allowedFolders, []);
        return {
          type: "object",
          required: ["context"],
          properties: { context: { type: "string", minLength: 1 } },
          additionalProperties: false,
        };
      },
    };
    assert.equal(
      await importWorkflowRepository(catalog, data, false, backend),
      1,
    );
    assert.equal(requests.length, 1);
    assert.match(requests[0].prompt, /Require a nonempty string context/);
    assert.equal(
      catalog.workflow("sample").value.expectedInput,
      definition.expectedInput,
    );
    assert.deepEqual(catalog.workflow("sample").value.inputSchema.properties, {
      context: { type: "string", minLength: 1 },
    });
    assert.equal(fs.existsSync(path.join(data, "runs")), false);
    assert.equal(fs.existsSync(path.join(data, "watches")), false);
    await importWorkflowRepository(catalog, data, true, backend);
    assert.equal(requests.length, 1);
    definition.expectedInput =
      "Require a nonempty string context describing the incident.";
    source.writeDefinition(definition);
    await importWorkflowRepository(catalog, data, true, backend);
    assert.equal(requests.length, 2);
    const saved = catalog.workflow("sample");
    catalog.saveWorkflow(
      { ...saved.value, name: "Owner edit" },
      saved.revision,
    );
    await assert.rejects(
      () => importWorkflowRepository(catalog, data, true, backend),
      /Local workflows\/sample changed/,
    );
    assert.equal(catalog.workflow("sample").value.name, "Owner edit");
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("schema-free imports require an input description but allow explicitly empty input without a backend", async () => {
  const root = temporaryRoot();
  try {
    const source = library(root);
    const data = path.join(root, "data");
    const catalog = createCatalog(data, source.config);
    source.writeDefinition({
      ...source.definition,
      inputSchema: undefined,
    });
    await assert.rejects(
      () => importWorkflowRepository(catalog, data),
      /Provide expectedInput or a legacy inputSchema/,
    );
    source.writeDefinition({
      ...source.definition,
      expectedInput: "",
      inputSchema: undefined,
    });
    const backend = {
      ...fixtureBackend(),
      diagnostics: () => ({ available: false, reason: "Unavailable" }),
      async execute() {
        throw new Error("Empty input must not invoke a model");
      },
    };
    await importWorkflowRepository(catalog, data, false, backend);
    assert.deepEqual(catalog.workflow("sample").value.inputSchema, {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("input compilation failures leave the catalog untouched and release the import claim", async () => {
  const root = temporaryRoot();
  try {
    const source = library(root);
    source.writeDefinition({
      ...source.definition,
      expectedInput: "Require context.",
      inputSchema: undefined,
    });
    const data = path.join(root, "data");
    const catalog = createCatalog(data, source.config);
    const backend = {
      ...fixtureBackend(),
      async execute() {
        throw new Error("Compilation failed");
      },
    };
    await assert.rejects(
      () => importWorkflowRepository(catalog, data, false, backend),
      /Compilation failed/,
    );
    assert.deepEqual(catalog.workflows(), []);
    assert.deepEqual(catalog.skills(), []);
    assert.equal(fs.existsSync(path.join(data, "workflow-import.json")), false);
    source.writeDefinition(source.definition);
    assert.equal(await importWorkflowRepository(catalog, data), 1);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("relative instructions cannot escape their workflow directory, including through symlinks", () => {
  const root = temporaryRoot();
  try {
    const source = library(root);
    const catalog = createCatalog(path.join(root, "data"), source.config);
    const outside = path.join(root, "outside.md");
    fs.writeFileSync(outside, "Outside");
    fs.symlinkSync(outside, path.join(source.base, "mds/link.md"));
    for (const file of [
      "../../../outside.md",
      "mds/link.md",
      "mds/missing.md",
    ]) {
      const definition = structuredClone(source.definition);
      definition.stages[0].agents[0].instructionsFile = file;
      assert.throws(
        () => catalog.runtimeWorkflow(definition),
        /escapes|ENOENT/,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("invalid export checksums fail before importing any definitions", async () => {
  const root = temporaryRoot();
  try {
    const source = library(root);
    const data = path.join(root, "data");
    const catalog = createCatalog(data, source.config);
    source.writeDefinition({
      ...source.definition,
      expectedInput: "Require context.",
      inputSchema: undefined,
    });
    let compilations = 0;
    const backend = {
      ...fixtureBackend(),
      async execute() {
        compilations++;
        throw new Error("Unverified exports must not invoke a model");
      },
    };
    fs.appendFileSync(
      path.join(source.base, "mds/work.md"),
      "\nUnrecorded edit",
    );
    await assert.rejects(
      () => importWorkflowRepository(catalog, data, false, backend),
      /checksum mismatch/,
    );
    assert.equal(compilations, 0);
    assert.equal(catalog.workflows().length, 0);
    assert.equal(catalog.skills().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("all workflow agents receive shared paths pinned at admission; ordinary restart does not redirect them", async () => {
  const root = temporaryRoot();
  let host: ReturnType<typeof createRunHost> | undefined;
  try {
    const source = library(root);
    const data = path.join(root, "data");
    const catalog = createCatalog(data, source.config);
    await importWorkflowRepository(catalog, data);
    const fixture = fixtureBackend();
    const requests: AgentRequest[] = [];
    let fail = true;
    host = createRunHost(data, catalog, {
      ...fixture,
      async execute(request, signal) {
        requests.push(request);
        if (request.purpose === "stage" && fail)
          throw new Error("Interrupted fixture");
        return fixture.execute(request, signal);
      },
    });
    const first = host.launch("sample", { context: "Evidence" }, "first");
    assert.equal(
      (await waitForRun(() => host!.store.get(first.id))).status,
      "blocked",
    );
    const snapshot = host.store.snapshot(first.id);
    assert.deepEqual(snapshot.paths, source.config.paths);
    assert.deepEqual(
      snapshot.allowedFolders,
      [...new Set(Object.values(source.config.paths))].sort(),
    );
    const other = path.join(root, "other checkout");
    fs.mkdirSync(other);
    source.config.paths.CHECKOUT = fs.realpathSync(other);
    fail = false;
    const continuation = host.rerun(first.id, "discover", "restart");
    assert.equal(
      (await waitForRun(() => host!.store.get(continuation.id))).status,
      "completed",
    );
    assert.equal(
      host.store.snapshot(continuation.id).paths?.CHECKOUT,
      source.checkout,
    );
    for (const request of requests.filter((item) => item.purpose === "stage")) {
      assert.equal(request.paths?.CHECKOUT, source.checkout);
      assert.deepEqual(request.allowedFolders, snapshot.allowedFolders);
    }
    source.config.paths.CHECKOUT = source.checkout;
    source.config.paths.EXTRA = other;
    assert.throws(
      () => host!.rerun(first.id, "discover", "changed-paths", undefined, true),
      /Configured paths changed/,
    );
  } finally {
    await host?.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("latest-instruction restart cannot introduce named paths into a legacy run", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root, { paths: {} });
  catalog.saveWorkflow(workflow());
  const host = createRunHost(root, catalog, fixtureBackend());
  try {
    const run = host.launch("sample", { context: "Evidence" }, "legacy");
    assert.equal(
      (await waitForRun(() => host.store.get(run.id))).status,
      "completed",
    );
    assert.equal(host.store.snapshot(run.id).paths, undefined);
    catalog.config.paths.CHECKOUT = root;
    assert.throws(
      () => host.rerun(run.id, "discover", "legacy-paths", undefined, true),
      /Configured paths changed/,
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("get_path MCP tool reads only pinned names and does not expose credentials or current environment paths", async () => {
  const root = temporaryRoot();
  const client = new Client({ name: "portability-test", version: "1" });
  try {
    const file = path.join(root, "paths.json");
    fs.writeFileSync(file, JSON.stringify({ CHECKOUT: root }));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../server/path-tool.ts", import.meta.url)),
          file,
        ],
        env: { ADO_PAT: "secret", STRAND_PATH_UNPINNED: "/other/machine" },
      }),
    );
    const result = await client.callTool({
      name: "get_path",
      arguments: { name: "CHECKOUT" },
    });
    assert.deepEqual(result.structuredContent, {
      name: "CHECKOUT",
      path: root,
    });
    for (const name of ["ADO_PAT", "UNPINNED"])
      assert.equal(
        (await client.callTool({ name: "get_path", arguments: { name } }))
          .isError,
        true,
      );
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true });
  }
});
