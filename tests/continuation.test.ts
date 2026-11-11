import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { createRunStore } from "../server/run-store.ts";
import { executeRun } from "../server/run-engine.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import type { AgentBackend } from "../server/agent-backend.ts";
import {
  acceptedOutputSchema,
  checkpointPrefix,
  outputArtifactName,
} from "../server/run-checkpoint.ts";
import { unitDetails } from "../server/unit-details.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";
import { writeJson } from "../server/files.ts";
import { processIdentity } from "../server/process-owner.ts";

type Request = Parameters<AgentBackend["execute"]>[0];

test("re-run waits for active cleanup, uses latest instructions and deduplicates submissions", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const value = workflow();
  catalog.saveWorkflow(value);
  const base = fixtureBackend();
  const entered = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const calls: Request[] = [];
  let first = true;
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "stage") {
        calls.push(request);
        if (first && request.prompt.includes('Execute stage "Report"')) {
          first = false;
          entered.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          stopping.resolve();
          await cleanup.promise;
          signal.throwIfAborted();
        }
      }
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const source = host.launch(
      value.id,
      { context: "Original task" },
      "active-source",
    );
    await entered.promise;
    await assert.rejects(
      host.rerunStage(source.id, "missing", "invalid-stage"),
      /Stage not found/,
    );
    assert.equal(host.store.get(source.id).status, "running");
    value.stages[1].agents[0].instructions =
      "Use the corrected report instructions.";
    catalog.saveWorkflow(value, catalog.workflow(value.id).revision);
    const firstRequest = host.rerunStage(source.id, "report", "active-rerun");
    const duplicate = host.rerunStage(source.id, "report", "active-rerun");
    await stopping.promise;
    assert.equal(
      host.store.list().length,
      1,
      "No child may start before cleanup",
    );
    assert.equal(calls.length, 3);
    cleanup.resolve();
    const [child, repeated] = await Promise.all([firstRequest, duplicate]);
    assert.equal(child.id, repeated.id);
    const result = await waitForRun(() => host.store.get(child.id));
    assert.equal(result.status, "completed", result.error);
    assert.equal(host.store.get(source.id).status, "cancelled");
    assert.equal(result.units["discover/alpha"].reusedFrom, source.id);
    assert.deepEqual(result.units["discover/alpha"].attempts, []);
    assert.equal(calls.length, 4);
    assert.match(calls.at(-1)!.prompt, /Use the corrected report instructions/);
    assert.equal(host.store.list().length, 2);
    assert.equal(
      (await host.rerunStage(source.id, "report", "active-rerun")).id,
      child.id,
    );
  } finally {
    cleanup.resolve();
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("re-run accepts queued, cancelled and completed runs", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const value = workflow();
  catalog.saveWorkflow(value);
  const host = createRunHost(root, catalog, fixtureBackend());
  try {
    const source = host.launch(
      value.id,
      { context: "Original task" },
      "queued-source",
    );
    const child = await host.rerunStage(source.id, "discover", "queued-rerun");
    assert.equal(host.store.get(source.id).status, "cancelled");
    assert.deepEqual(host.store.get(source.id).units, {});
    assert.equal(
      (await waitForRun(() => host.store.get(child.id))).status,
      "completed",
    );
    for (const [id, stageId, requestId] of [
      [source.id, "discover", "cancelled-rerun"],
      [child.id, "report", "completed-rerun"],
    ]) {
      const next = await host.rerunStage(id, stageId, requestId);
      const result = await waitForRun(() => host.store.get(next.id));
      assert.equal(result.status, "completed", result.error);
      assert.equal(result.units["report/writer"].attempts.length, 1);
    }
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("plain-language continuations can restart and skip a blocked loop stage", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const value = definition();
  value.stages.push({
    ...value.stages[2],
    id: "archive",
    name: "Archive",
    agents: [{ ...value.stages[2].agents[0], id: "archiver" }],
  });
  for (const stage of value.stages) {
    stage.expectedOutput = "Return an object with a summary.";
    stage.inputs = {};
  }
  value.stages[2].loop = {
    targetStageId: "report",
    condition: {
      agentId: "publisher",
      pointer: "/needsAnotherPass",
      operator: "equals",
      value: true,
    },
    maxIterations: 3,
    feedback: {},
  };
  catalog.saveWorkflow(value);
  const base = fixtureBackend();
  const calls: Request[] = [];
  let recover = false;
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "stage") {
        calls.push(request);
        if (request.prompt.includes('Execute stage "Publish"'))
          return {
            summary: recover ? "Reviewed changes" : "Missing optional evidence",
            status: recover ? "ready" : "blocked",
            needsAnotherPass: false,
          };
      }
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const source = host.launch(
      value.id,
      { context: "Keep the completed workspace changes" },
      "plain-language-source",
    );
    const blocked = await waitForRun(() => host.store.get(source.id));
    assert.equal(blocked.status, "blocked", blocked.error);
    assert.equal(blocked.currentStage, "publish");
    recover = true;
    for (const skip of [false, true]) {
      calls.length = 0;
      const child = host.rerun(
        source.id,
        "publish",
        skip ? "plain-language-skip" : "plain-language-restart",
        skip
          ? {
              reason: "Owner chooses to bypass review",
              allowPublication: false,
            }
          : undefined,
        !skip,
      );
      const result = await waitForRun(() => host.store.get(child.id));
      assert.equal(result.status, "completed", result.error);
      assert.equal(calls.length, skip ? 1 : 2);
      for (const key of ["discover/alpha", "discover/beta", "report/writer"]) {
        assert.equal(result.units[key].reusedFrom, source.id);
        assert.deepEqual(result.units[key].attempts, []);
        assert.deepEqual(result.units[key].output, blocked.units[key].output);
      }
      assert.equal(
        result.units["publish/publisher"].status,
        skip ? "skipped" : "completed",
      );
      assert.deepEqual(
        calls.at(-1)!.input,
        result.units["publish/publisher"].output,
      );
      assert.equal(host.store.get(source.id).status, "blocked");
    }
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("stage restarts execute authored instructions without engine-defined setup policies", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const value = workflow();
  value.stages[0].agents[0].instructions =
    "Rebuild the search index for the supplied context.";
  value.stages[1].agents[0].instructions =
    "Replace the report using the supplied evidence.";
  catalog.saveWorkflow(value);
  const base = fixtureBackend();
  const calls: Request[] = [];
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "stage") calls.push(request);
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const source = host.launch(
      "sample",
      { context: "Original work" },
      "source",
    );
    await waitForRun(() => host.store.get(source.id));
    for (const stageId of ["discover", "report"]) {
      calls.length = 0;
      const restart = host.rerun(source.id, stageId, `restart-${stageId}`);
      const result = await waitForRun(() => host.store.get(restart.id));
      assert.equal(result.status, "completed", result.error);
      assert.equal(calls.length, stageId === "discover" ? 3 : 1);
      for (const request of calls) {
        assert.match(
          request.prompt,
          /Execute the restarted stages according to their own instructions/,
        );
        assert.doesNotMatch(
          request.prompt,
          /workspace|master refresh|ticket|branch creation|fresh setup|executionId/i,
        );
        assert(request.directory.startsWith(host.store.directory(restart.id)));
      }
      assert.match(
        calls.at(-1)!.prompt,
        /Replace the report using the supplied evidence/,
      );
      if (stageId === "discover")
        assert.match(calls[0].prompt, /Rebuild the search index/);
      else
        assert.match(calls[0].prompt, /Earlier stages are reused, not rerun/);
    }
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("owner skips preserve history, never execute skipped agents, and survive resume and later reruns", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const value = definition();
  catalog.saveWorkflow(value);
  const base = fixtureBackend();
  const calls: Request[] = [];
  let failPublish = true;
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose !== "summary") calls.push(request);
      if (
        request.purpose === "stage" &&
        request.prompt.includes('Execute stage "Report"')
      )
        return { status: "blocked", summary: "Original Test-like blocker" };
      if (
        request.purpose === "stage" &&
        request.prompt.includes('Execute stage "Publish"') &&
        failPublish
      )
        throw new Error("Unrelated downstream failure");
      return base.execute(request, signal);
    },
  };
  let host = createRunHost(root, catalog, backend);
  try {
    const source = host.launch(
      value.id,
      { context: "Keep existing implementation" },
      "skip-source",
    );
    const blocked = await waitForRun(() => host.store.get(source.id));
    assert.equal(blocked.currentStage, "report");
    const history = fs.readFileSync(
      path.join(host.store.directory(source.id), "state.json"),
    );
    const override = {
      reason: "Owner elects to skip this check only",
      allowPublication: true,
    };
    assert.throws(
      () => host.rerun(source.id, "discover", "skip-wrong-stage", override),
      /Only the current stage/,
    );
    assert.throws(() =>
      host.rerun(source.id, "report", "skip-empty-reason", {
        ...override,
        reason: " ",
      }),
    );
    calls.length = 0;
    const child = host.rerun(source.id, "report", "skip-child", override);
    assert.equal(
      host.rerun(source.id, "report", "skip-child", override).id,
      child.id,
    );
    assert.throws(
      () => host.rerun(source.id, "report", "skip-child"),
      /identity was reused/,
    );
    assert.throws(
      () =>
        host.rerun(source.id, "report", "skip-child", {
          ...override,
          allowPublication: false,
        }),
      /identity was reused/,
    );
    assert.throws(
      () =>
        host.rerun(source.id, "report", "skip-child", {
          ...override,
          reason: "Different authorization",
        }),
      /identity was reused/,
    );
    const failed = await waitForRun(() => host.store.get(child.id));
    assert.equal(failed.status, "blocked");
    assert.equal(failed.currentStage, "publish");
    const skipped = failed.units["report/writer"];
    assert.equal(skipped.status, "skipped");
    assert.equal(failed.units["@schema/report"].status, "skipped");
    assert.deepEqual(skipped.attempts, []);
    assert.deepEqual(failed.units["@schema/report"].attempts, []);
    assert.equal(calls.length, 2, "Only downstream contract and agent execute");
    assert.match(JSON.stringify(skipped.output), /"status":"skipped"/);
    assert.doesNotMatch(
      JSON.stringify(skipped.output),
      /allRequiredChecksPassed/,
    );
    assert.equal(failed.stageSkips?.[0].reason, override.reason);
    assert.equal(failed.stageSkips?.[0].allowPublication, true);
    assert.deepEqual(
      host.store.snapshot(child.id).stageSkips,
      failed.stageSkips,
    );
    const publish = calls.find((request) => request.purpose === "stage");
    assert(publish);
    assert.match(publish.prompt, /Skipped is not passed/);
    assert.match(publish.prompt, /permits downstream commit\/push\/PR/);
    assert.match(publish.prompt, /real defects/i);
    assert.match(publish.prompt, /Earlier stages are reused, not rerun/);
    assert.match(JSON.stringify(publish.input), /skipped by owner/);
    assert.match(calls[0].prompt, /Explicit owner-authorized stage skips/);
    host.store.verify(child.id);
    await host.close();
    failPublish = false;
    calls.length = 0;
    host = createRunHost(root, catalog, backend);
    host.resume(child.id);
    const resumed = await waitForRun(() => host.store.get(child.id));
    assert.equal(resumed.status, "completed", resumed.error);
    assert.equal(calls.length, 1, "Resume reuses contract and skipped handoff");
    assert.equal(resumed.units["report/writer"].status, "skipped");
    assert.deepEqual(resumed.units["report/writer"].attempts, []);
    calls.length = 0;
    const later = host.rerun(child.id, "publish", "after-skip");
    const completed = await waitForRun(() => host.store.get(later.id));
    assert.equal(completed.status, "completed", completed.error);
    assert.deepEqual(completed.stageSkips, resumed.stageSkips);
    assert.equal(completed.units["report/writer"].status, "skipped");
    assert.equal(completed.units["report/writer"].reusedFrom, child.id);
    assert.match(
      calls.find((request) => request.purpose === "stage")!.prompt,
      /Skipped is not passed/,
    );
    const retryStage = host.rerun(later.id, "report", "actually-run-again");
    const retry = await waitForRun(() => host.store.get(retryStage.id));
    assert.equal(retry.status, "blocked");
    assert.equal(
      retry.stageSkips,
      undefined,
      "Rerunning the skipped stage removes its override",
    );
    assert.equal(retry.units["report/writer"].attempts.length, 1);
    assert.deepEqual(
      fs.readFileSync(path.join(host.store.directory(source.id), "state.json")),
      history,
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("skips without publication authorization retain an explicit downstream prohibition", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(definition());
  const base = fixtureBackend();
  const calls: Request[] = [];
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      calls.push(request);
      if (
        request.purpose === "stage" &&
        request.prompt.includes('Execute stage "Report"')
      )
        return { status: "blocked", summary: "Check unavailable" };
      if (
        request.purpose === "stage" &&
        request.prompt.includes('Execute stage "Publish"')
      )
        return {
          status: "blocked",
          summary: "A real review finding still blocks publication",
        };
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const source = host.launch(
      "sample",
      { context: "Review only" },
      "no-publish-source",
    );
    await waitForRun(() => host.store.get(source.id));
    calls.length = 0;
    const child = host.rerun(source.id, "report", "no-publish-child", {
      reason: "Owner wants read-only continuation",
      allowPublication: false,
    });
    const result = await waitForRun(() => host.store.get(child.id));
    assert.equal(
      result.status,
      "blocked",
      "A later real blocker is not bypassed",
    );
    assert.match(result.error!, /reported status "blocked"/);
    assert.equal(result.stageSkips?.[0].allowPublication, false);
    assert.match(
      calls.find((request) => request.purpose === "stage")!.prompt,
      /Publication is NOT authorized/,
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

function definition() {
  const value = workflow();
  value.stages.push({
    ...value.stages[1],
    id: "publish",
    name: "Publish",
    inputs: {
      result: {
        source: "stage",
        stageId: "report",
        agentId: "writer",
        pointer: "/summary",
      },
    },
    agents: [{ ...value.stages[1].agents[0], id: "publisher" }],
  });
  return value;
}

test("stage reruns reuse only verified prefix checkpoints and preserve pinned context and original history", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const value = definition();
  const folder = path.join(root, "workspace");
  fs.mkdirSync(folder);
  value.stages[1].agents[0].allowedFolders = [folder];
  value.stages[1].agents[0].model = "pinned-model";
  catalog.saveWorkflow(value);
  const base = fixtureBackend();
  const calls: Request[] = [];
  let recover = false;
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose !== "summary") calls.push(request);
      const output = await base.execute(request, signal);
      return request.purpose === "stage" &&
        !request.prompt.includes('Execute stage "Discover"')
        ? {
            summary: recover
              ? "Fresh continuation output"
              : "Original blocked output",
            status: recover ? "ready" : "blocked",
          }
        : output;
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const source = host.launch(
      value.id,
      { context: "Keep original context" },
      "original",
      undefined,
      true,
    );
    const blocked = await waitForRun(() => host.store.get(source.id));
    assert.equal(blocked.status, "blocked", blocked.error);
    assert.equal(blocked.currentStage, "report");
    assert.equal(blocked.units["publish/publisher"], undefined);
    const count = host.store.list().length;
    assert.throws(
      () => host.rerun(source.id, "publish", "skip-blocker"),
      /Report: Writer reported status "blocked"/,
    );
    assert.equal(host.store.list().length, count);
    const original = fs.readFileSync(
      path.join(host.store.directory(source.id), "state.json"),
      "utf8",
    );
    const pinned = host.store.snapshot(source.id);
    const saved = catalog.workflow(value.id);
    catalog.saveWorkflow(
      {
        ...saved.value,
        name: "Changed after launch",
        stages: [saved.value.stages[0]],
      },
      saved.revision,
    );
    recover = true;
    calls.length = 0;
    const child = host.rerun(source.id, "report", "rerun");
    assert.equal(host.rerun(source.id, "report", "rerun").id, child.id);
    assert.throws(
      () => host.rerun(source.id, "discover", "rerun"),
      /identity was reused/,
    );
    assert.throws(
      () => host.launch(value.id, pinned.input, "rerun", undefined, true),
      /identity was reused/,
    );
    const result = await waitForRun(() => host.store.get(child.id));
    assert.equal(result.status, "completed", result.error);
    assert.deepEqual(result.continuation, {
      sourceRunId: source.id,
      fromStageId: "report",
    });
    const childSnapshot = host.store.snapshot(child.id);
    assert.deepEqual(childSnapshot.workflow, pinned.workflow);
    assert.deepEqual(childSnapshot.skills, pinned.skills);
    assert.deepEqual(childSnapshot.input, pinned.input);
    assert.equal(childSnapshot.allowAllTools, true);
    assert.equal(
      calls.length,
      4,
      "Only Report and Publish contracts and agents should execute",
    );
    assert(
      calls.every(
        (request) => !request.prompt.includes('Execute stage "Discover"'),
      ),
    );
    const report = calls.find(
      (request) =>
        request.purpose === "stage" &&
        request.prompt.includes('Execute stage "Report"'),
    );
    assert(report);
    assert.equal(report.model, "pinned-model");
    assert.deepEqual(report.allowedFolders, [fs.realpathSync(folder)]);
    assert.equal(report.allowAllTools, true);
    assert.match(report.prompt, /Earlier stages are reused, not rerun/);
    assert.match(report.prompt, /Original blocked output/);
    assert.match(report.prompt, /Historical attempt of this agent/);
    for (const agent of ["alpha", "beta"]) {
      const unit = result.units[`discover/${agent}`];
      assert.equal(unit.reusedFrom, source.id);
      assert.deepEqual(unit.attempts, []);
      assert.deepEqual(
        unit.output,
        host.store.get(source.id).units[`discover/${agent}`].output,
      );
      const details = unitDetails(host.store, child.id, `discover/${agent}`);
      assert.deepEqual(details.output, unit.output);
      assert.equal(
        acceptedOutputSchema.parse(
          host.store.readArtifact(
            child.id,
            outputArtifactName("discover", agent),
          ),
        ).runId,
        child.id,
      );
    }
    assert.match(
      JSON.stringify(result.units["report/writer"].output),
      /Fresh continuation output/,
    );
    assert.equal(
      fs.readFileSync(
        path.join(host.store.directory(source.id), "state.json"),
        "utf8",
      ),
      original,
    );
    calls.length = 0;
    const grandchild = host.rerun(child.id, "report", "rerun-again");
    assert.equal(
      (await waitForRun(() => host.store.get(grandchild.id))).status,
      "completed",
    );
    assert.equal(calls.length, 4);
    assert.equal(
      host.store.get(grandchild.id).units["discover/alpha"].reusedFrom,
      child.id,
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("previously queued continuations cannot execute past an inherited blocked outcome", async () => {
  const root = temporaryRoot();
  const store = createRunStore(root);
  const value = workflow();
  value.stages[0].outputSchema.properties = {
    summary: { type: "string" },
    status: { type: "string" },
  };
  const input = { context: "Inherited business blocker" };
  const base = fixtureBackend();
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "stage")
        return {
          summary: "Checkpoint evidence",
          status: request.prompt.includes("You are Alpha.")
            ? "blocked"
            : "ready",
        };
      return base.execute(request, signal);
    },
  };
  try {
    const source = store.create(value, [], input, "blocked-prefix", backend.id);
    await executeRun(store, source.id, backend, new AbortController().signal);
    const child = store.create(
      value,
      [],
      input,
      "queued-before-gate",
      backend.id,
      undefined,
      false,
      {
        continuation: {
          sourceRunId: source.id,
          fromStageId: "report",
          checkpoints: [
            {
              stageId: "discover",
              contract: value.stages[0].outputSchema,
              outputs: Object.fromEntries(
                value.stages[0].agents.map((agent) => [
                  agent.id,
                  acceptedOutputSchema.parse(
                    store.readArtifact(
                      source.id,
                      outputArtifactName("discover", agent.id),
                    ),
                  ),
                ]),
              ),
            },
          ],
          history: {},
        },
      },
    );
    let calls = 0;
    await executeRun(
      store,
      child.id,
      {
        ...base,
        async execute(request, signal) {
          calls++;
          return base.execute(request, signal);
        },
      },
      new AbortController().signal,
    );
    const blocked = store.get(child.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.currentStage, "discover");
    assert.match(blocked.error!, /Alpha reported status "blocked"/);
    assert.equal(calls, 0);
    assert.equal(blocked.units["discover/alpha"].reusedFrom, source.id);
    assert.deepEqual(blocked.units["discover/alpha"].attempts, []);
    assert.equal(blocked.units["@schema/report"], undefined);
    assert.equal(blocked.units["report/writer"], undefined);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("queued continuation recovery and resume never execute inherited agents or reuse downstream outputs", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  catalog.saveWorkflow(definition());
  const base = fixtureBackend();
  const calls: Request[] = [];
  let continuing = false;
  let fail = true;
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (continuing && request.purpose !== "summary") {
        calls.push(request);
        assert(
          !request.prompt.includes('Execute stage "Discover"'),
          "Inherited agents must never execute",
        );
        if (
          fail &&
          request.purpose === "stage" &&
          request.prompt.includes('Execute stage "Report"')
        )
          throw new Error("Temporary continuation failure");
      }
      return base.execute(request, signal);
    },
  };
  let host = createRunHost(root, catalog, backend);
  try {
    const source = host.launch(
      "sample",
      { context: "Recovery" },
      "restart-source",
    );
    await waitForRun(() => host.store.get(source.id));
    const child = host.rerun(source.id, "report", "restart-child");
    assert.equal(
      host.store.readArtifactIfPresent(child.id, "schema-discover.json"),
      undefined,
    );
    await host.close();
    continuing = true;
    host = createRunHost(root, catalog, backend);
    const blocked = await waitForRun(() => host.store.get(child.id));
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.error!, /Temporary continuation failure/);
    assert.equal(calls.length, 2);
    assert.equal(blocked.units["discover/alpha"].reusedFrom, source.id);
    assert.equal(
      host.store.readArtifactIfPresent(
        child.id,
        outputArtifactName("report", "writer"),
      ),
      undefined,
    );
    await host.close();
    fail = false;
    calls.length = 0;
    host = createRunHost(root, catalog, backend);
    host.resume(child.id);
    const resumed = await waitForRun(() => host.store.get(child.id));
    assert.equal(resumed.status, "completed", resumed.error);
    assert.equal(
      calls.length,
      3,
      "Resume reuses the already accepted Report contract",
    );
    assert.equal(resumed.units["report/writer"].attempts.length, 2);
    assert.equal(resumed.units["discover/alpha"].attempts.length, 0);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("stage admission rejects active sources, incomplete prefixes and orphan processes", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const value = definition();
  catalog.saveWorkflow(value);
  const base = fixtureBackend();
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (
        request.purpose === "stage" &&
        request.prompt.includes('Execute stage "Report"')
      )
        throw new Error("No accepted Report output");
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const source = host.launch(
      "sample",
      { context: "Admission" },
      "admission-source",
    );
    assert.throws(
      () => host.rerun(source.id, "discover", "active"),
      /Stop or finish/,
    );
    await waitForRun(() => host.store.get(source.id));
    const count = host.store.list().length;
    assert.throws(
      () => host.rerun(source.id, "missing", "unknown"),
      /Stage not found/,
    );
    assert.throws(
      () => host.rerun(source.id, "publish", "missing-prefix"),
      /no accepted output/,
    );
    assert.equal(host.store.list().length, count);
    const attempt = host.store.get(source.id).units["report/writer"]
      .attempts[0];
    const wrapper = path.join(
      host.store.directory(source.id),
      "attempts",
      attempt.id,
      "wrapper.json",
    );
    writeJson(wrapper, {
      pid: process.pid,
      identity: processIdentity(process.pid),
    });
    assert.throws(
      () => host.rerun(source.id, "report", "orphan"),
      /Cannot restart.*still active/,
    );
    fs.unlinkSync(wrapper);
    assert.doesNotThrow(() =>
      host.rerun(source.id, "report", "retry-after-orphan"),
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("invalid continuation checkpoints fail closed before any agent can execute", async () => {
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
    const source = store.create(
      workflow(),
      [],
      { context: "Checkpoint source" },
      "checkpoint-source",
      base.id,
    );
    await executeRun(store, source.id, base, new AbortController().signal);
    const originalCheckpoints = checkpointPrefix(store, source.id, "report");
    const run = store.create(
      workflow(),
      [],
      { context: "Missing imported setup" },
      "bad-checkpoints",
      base.id,
      undefined,
      false,
      {
        continuation: {
          sourceRunId: "run-original",
          fromStageId: "report",
          checkpoints: [],
          history: {},
        },
      },
    );
    await executeRun(store, run.id, backend, new AbortController().signal);
    assert.equal(store.get(run.id).status, "blocked");
    assert.match(store.get(run.id).error!, /checkpoints do not match/);
    assert.equal(calls, 0);
    const invalid = structuredClone(originalCheckpoints);
    invalid[0].outputs.alpha.inputDigest = "different-input";
    const wrongIdentity = store.create(
      workflow(),
      [],
      { context: "Checkpoint source" },
      "wrong-input",
      base.id,
      undefined,
      false,
      {
        continuation: {
          sourceRunId: source.id,
          fromStageId: "report",
          checkpoints: invalid,
          history: {},
        },
      },
    );
    await executeRun(
      store,
      wrongIdentity.id,
      backend,
      new AbortController().signal,
    );
    assert.equal(store.get(wrongIdentity.id).status, "blocked");
    assert.match(
      store.get(wrongIdentity.id).error!,
      /Inherited output identity mismatch/,
    );
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
