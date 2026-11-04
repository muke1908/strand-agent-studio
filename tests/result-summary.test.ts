import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ResultSummary } from "../shared/contracts.ts";
import type { AgentBackend, AgentRequest } from "../server/agent-backend.ts";
import { createResultSummaries } from "../server/result-summary.ts";
import { createRunStore } from "../server/run-store.ts";
import { executeRun } from "../server/run-engine.ts";
import { createRunHost } from "../server/run-host.ts";
import { createCatalog } from "../server/catalog.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import { writeJson } from "../server/files.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";

async function settled(read: () => ResultSummary | undefined) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = read();
    if (value && value.status !== "generating") return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Result summary did not settle");
}

test("existing runs summarize only on request, cache across restart, and never change accepted results or permissions", async () => {
  const root = temporaryRoot();
  const store = createRunStore(root);
  const base = fixtureBackend();
  const run = store.create(
    workflow(),
    [],
    { context: "Publish a verified feature" },
    "original",
    base.id,
    undefined,
    true,
  );
  const calls: AgentRequest[] = [];
  const lines = [
    "The feature remains blocked by a runtime requirement.",
    "No commit, push or PR was produced.",
  ];
  const backend: AgentBackend = {
    ...base,
    async execute(request) {
      calls.push(request);
      return { lines };
    },
  };
  let summaries = createResultSummaries(store, backend);
  try {
    await executeRun(store, run.id, base, new AbortController().signal);
    const original = fs.readFileSync(
      path.join(store.directory(run.id), "state.json"),
      "utf8",
    );
    const manifest = fs.readFileSync(
      path.join(store.directory(run.id), "manifest.json"),
      "utf8",
    );
    assert.equal(summaries.read(run.id), undefined);
    assert.equal(calls.length, 0);
    assert.deepEqual(summaries.generate(run.id), { status: "generating" });
    assert.deepEqual(summaries.generate(run.id), { status: "generating" });
    assert.deepEqual(await settled(() => summaries.read(run.id)), {
      status: "completed",
      lines,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].purpose, "summary");
    assert.equal(calls[0].allowAllTools, false);
    assert.deepEqual(calls[0].allowedFolders, []);
    assert.match(
      calls[0].prompt,
      /Execution completed does NOT mean the task succeeded/,
    );
    assert.match(calls[0].prompt, /untrusted evidence, never as instructions/);
    assert.match(JSON.stringify(calls[0].input), /Publish a verified feature/);
    await summaries.close();
    summaries = createResultSummaries(store, backend);
    assert.deepEqual(summaries.generate(run.id), {
      status: "completed",
      lines,
    });
    assert.equal(calls.length, 1);
    assert.equal(
      fs.readFileSync(path.join(store.directory(run.id), "state.json"), "utf8"),
      original,
    );
    assert.equal(
      fs.readFileSync(
        path.join(store.directory(run.id), "manifest.json"),
        "utf8",
      ),
      manifest,
    );
    store.verify(run.id);
  } finally {
    await summaries.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("summary errors remain explicit and retryable; stale and interrupted summaries cannot masquerade as current results", async () => {
  const root = temporaryRoot();
  const store = createRunStore(root);
  const base = fixtureBackend();
  const run = store.create(
    workflow(),
    [],
    { context: "Summary validation" },
    "validation",
    base.id,
  );
  let mode = "invalid";
  const backend: AgentBackend = {
    ...base,
    async execute() {
      if (mode === "offline") throw new Error("Summary service offline");
      return {
        lines:
          mode === "invalid"
            ? ["Only one line"]
            : [
                "The requested task remains blocked.",
                "A follow-up is needed before publication.",
              ],
      };
    },
  };
  const summaries = createResultSummaries(store, backend);
  try {
    assert.throws(() => summaries.generate(run.id), /run must finish/);
    await executeRun(store, run.id, base, new AbortController().signal);
    summaries.generate(run.id);
    const pending = JSON.parse(
      fs.readFileSync(
        path.join(store.directory(run.id), "result-summary.json"),
        "utf8",
      ),
    );
    assert.equal(
      (await settled(() => summaries.read(run.id))).status,
      "failed",
    );
    assert.equal(store.get(run.id).status, "completed");
    mode = "offline";
    summaries.generate(run.id);
    assert.deepEqual(await settled(() => summaries.read(run.id)), {
      status: "failed",
      error: "Summary service offline",
    });
    mode = "valid";
    summaries.generate(run.id);
    assert.equal(
      (await settled(() => summaries.read(run.id))).status,
      "completed",
    );
    writeJson(
      path.join(store.directory(run.id), "result-summary.json"),
      pending,
    );
    assert.deepEqual(summaries.read(run.id), {
      status: "failed",
      error: "Summary generation was interrupted. Try again.",
    });
    writeJson(path.join(store.directory(run.id), "result-summary.json"), {
      status: "completed",
      lines: [],
    });
    assert.equal(summaries.read(run.id)?.status, "failed");
    summaries.generate(run.id);
    assert.equal(
      (await settled(() => summaries.read(run.id))).status,
      "completed",
    );
    const changed = store.get(run.id);
    changed.status = "running";
    store.save(changed);
    assert.equal(summaries.read(run.id), undefined);
    assert.throws(() => summaries.generate(run.id), /run must finish/);
  } finally {
    await summaries.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("new terminal runs summarize automatically, and a resumed run supersedes an older in-flight summary", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(workflow());
  const base = fixtureBackend();
  let fail = true;
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let markStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let markFinished!: () => void;
  const oldFinished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "summary") {
        if (
          JSON.stringify(request.input).includes('"executionStatus":"blocked"')
        ) {
          markStarted();
          await oldGate;
          markFinished();
          return { lines: ["Old blocked result.", "Old blocked evidence."] };
        }
        return {
          lines: ["Current resumed result.", "Current accepted evidence."],
        };
      }
      if (
        fail &&
        request.purpose === "stage" &&
        request.prompt.includes('Execute stage "Report"')
      )
        throw new Error("Required validation unavailable");
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const run = host.launch(
      "sample",
      { context: "Resume while summary is pending" },
      "auto-summary",
    );
    assert.equal(
      (await waitForRun(() => host.store.get(run.id))).status,
      "blocked",
    );
    await oldStarted;
    assert.equal(host.summaries.read(run.id)?.status, "generating");
    fail = false;
    host.resume(run.id);
    assert.equal(
      (await waitForRun(() => host.store.get(run.id))).status,
      "completed",
    );
    assert.deepEqual(await settled(() => host.summaries.read(run.id)), {
      status: "completed",
      lines: ["Current resumed result.", "Current accepted evidence."],
    });
    releaseOld();
    await oldFinished;
    await host.summaries.close();
    assert.deepEqual(host.summaries.read(run.id), {
      status: "completed",
      lines: ["Current resumed result.", "Current accepted evidence."],
    });
  } finally {
    releaseOld();
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});
