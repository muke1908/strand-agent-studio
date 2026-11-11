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
import { validateJson } from "../server/validation.ts";
import { unitDetails } from "../server/unit-details.ts";
import { digest, writeJson } from "../server/files.ts";
import { createRunStore } from "../server/run-store.ts";
import { executeRun } from "../server/run-engine.ts";
import { checkpointPrefix } from "../server/run-checkpoint.ts";
import { executeProcess } from "../server/process-runner.ts";
import type { Json } from "../shared/contracts.ts";

test("plain-language contracts pass the original input and complete results without bindings", async (t) => {
  for (const parallel of [false, true]) {
    await t.test(
      parallel ? "parallel results" : "single scalar result",
      async () => {
        const root = temporaryRoot();
        const catalog = createCatalog(root);
        const definition = workflow();
        const original = { context: "Keep the complete user request." };
        const outputs: Record<string, Json> = parallel
          ? {
              alpha: {
                scope: "src/feature.ts",
                solution: ["Reuse the existing helper", "Test recovery"],
                evidence: { lines: [12, 24] },
              },
              beta: "The complete second perspective, without summarization.",
            }
          : { alpha: true };
        if (!parallel) definition.stages[0].agents.length = 1;
        for (const stage of definition.stages) {
          stage.expectedOutput = `Return the complete result of ${stage.name}.`;
          stage.inputs = {};
        }
        catalog.saveWorkflow(definition);
        const base = fixtureBackend();
        const requests: Parameters<AgentBackend["execute"]>[0][] = [];
        const backend: AgentBackend = {
          ...base,
          async execute(request, signal) {
            requests.push(request);
            if (request.purpose === "schema") {
              assert.match(
                request.prompt,
                /## Expected output\nReturn the complete result/,
              );
              assert.doesNotMatch(request.prompt, /## Starting schema/);
              assert.match(request.prompt, /required top-level "status"/);
              assert.match(
                request.prompt,
                /"enum":\["blocked","failed","completed"\]/,
              );
              assert.match(
                request.prompt,
                /scalar or array results.*required "result" property/,
              );
              assert.match(
                request.prompt,
                /On blocked or failed outcomes, allow unavailable success data to be omitted/,
              );
            }
            if (request.purpose === "stage") {
              const first = request.prompt.includes('Execute stage "Discover"');
              assert.match(
                request.prompt,
                /## Expected output\nReturn the complete result/,
              );
              assert.match(request.prompt, /Keep the complete user request/);
              assert.deepEqual(
                request.input,
                first ? original : parallel ? outputs : outputs.alpha,
              );
              if (first)
                return request.prompt.includes("You are Alpha.")
                  ? outputs.alpha
                  : outputs.beta;
              return { summary: "Complete report" };
            }
            return base.execute(request, signal);
          },
        };
        const host = createRunHost(root, catalog, backend);
        try {
          const run = host.launch(definition.id, original, "natural-handoff");
          const finished = await waitForRun(() => host.store.get(run.id));
          assert.equal(finished.status, "completed", finished.error);
          const report = requests.find(
            (request) =>
              request.purpose === "stage" &&
              request.prompt.includes('Execute stage "Report"'),
          )!;
          assert.deepEqual(
            unitDetails(host.store, run.id, "report/writer").input.stageInput,
            report.input,
          );
          assert.equal(
            unitDetails(host.store, run.id, "@schema/report").input,
            definition.stages[1].expectedOutput,
          );
          assert.deepEqual(
            JSON.parse(
              report.prompt.split("## Complete accepted handoffs\n")[1],
            ),
            Object.fromEntries(
              Object.entries(outputs).map(([agent, output]) => [
                `discover/${agent}`,
                output,
              ]),
            ),
          );
        } finally {
          await host.close();
          fs.rmSync(root, { recursive: true });
        }
      },
    );
  }
});

test("legacy stage instructions are ignored while agent instructions drive execution and contracts", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = workflow();
  definition.stages[0].instructions = "Legacy stage policy must not execute.";
  definition.stages[0].agents[0].instructions =
    "Follow the agent-owned policy.";
  catalog.saveWorkflow(definition);
  const base = fixtureBackend();
  const calls: Parameters<AgentBackend["execute"]>[0][] = [];
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      calls.push(request);
      assert.doesNotMatch(request.prompt, /Legacy stage policy/);
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const run = host.launch(
      definition.id,
      { context: "Use only agent instructions." },
      "agent-only-instructions",
    );
    const finished = await waitForRun(() => host.store.get(run.id));
    assert.equal(finished.status, "completed", finished.error);
    const contract = calls.find(
      (request) =>
        request.purpose === "schema" && request.prompt.includes('"Discover"'),
    )!;
    const agent = calls.find(
      (request) =>
        request.purpose === "stage" &&
        request.prompt.includes("You are Alpha."),
    )!;
    assert.match(contract.prompt, /Follow the agent-owned policy/);
    assert.match(contract.prompt, /required top-level "status"/);
    assert.match(contract.prompt, /"enum":\["blocked","failed","completed"\]/);
    assert.match(agent.prompt, /Follow the agent-owned policy/);
    const details = unitDetails(host.store, run.id, "discover/alpha");
    assert.equal(Object.hasOwn(details.input, "stageInstructions"), false);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("repository-only actions return scalar counts, while blockers never publish a count", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = workflow("assigned-pr-count");
  definition.inputSchema = {
    type: "object",
    properties: { repositoryUrl: { type: "string", minLength: 1 } },
    required: ["repositoryUrl"],
    additionalProperties: false,
  };
  const stage = definition.stages[0];
  stage.inputs = {
    repositoryUrl: { source: "input", pointer: "/repositoryUrl" },
  };
  stage.outputSchema = { type: "integer", minimum: 0 };
  stage.expectedOutput = "Return only the nonnegative integer count.";
  stage.agents = [stage.agents[0]];
  definition.stages = [stage];
  catalog.saveWorkflow(definition);
  const base = fixtureBackend();
  let output: Json = 0;
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "stage") {
        assert.deepEqual(request.input, {
          repositoryUrl: "https://dev.azure.com/example/project/_git/repo",
        });
        assert.deepEqual(request.schema, stage.outputSchema);
        return output;
      }
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const results: Json[] = [
      0,
      7,
      { status: "blocked", summary: "Azure DevOps authentication failed." },
      { status: "blocked", summary: "Azure DevOps PR API request failed." },
    ];
    for (const [index, result] of results.entries()) {
      output = result;
      const run = host.launch(
        definition.id,
        { repositoryUrl: "https://dev.azure.com/example/project/_git/repo" },
        `scalar-count-${index}`,
      );
      const finished = await waitForRun(() => host.store.get(run.id));
      if (typeof result === "number") {
        assert.equal(finished.status, "completed", finished.error);
        assert.equal(finished.result, result);
        validateJson(stage.outputSchema, finished.result);
      } else {
        assert.equal(finished.status, "blocked");
        assert.equal(finished.result, undefined);
        assert.match(finished.error!, /reported status "blocked"/);
        assert.deepEqual(finished.units["discover/alpha"].output, result);
      }
    }
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("action results have no format-dependent wrapping and preserve explicit selections or parallel arrays", async (t) => {
  for (const mode of ["natural", "selected", "no-description", "parallel"]) {
    await t.test(mode, async () => {
      const root = temporaryRoot();
      const catalog = createCatalog(root);
      const definition = workflow();
      const stage = definition.stages[0];
      definition.stages = [stage];
      if (mode !== "no-description")
        stage.expectedOutput = "Return the complete summary object.";
      if (mode !== "parallel") stage.agents = [stage.agents[0]];
      if (mode === "selected")
        definition.result = {
          source: "stage",
          stageId: stage.id,
          agentId: stage.agents[0].id,
          pointer: "/summary",
        };
      catalog.saveWorkflow(definition);
      const base = fixtureBackend();
      const output = { summary: "Complete action result" };
      const host = createRunHost(root, catalog, {
        ...base,
        async execute(request, signal) {
          return request.purpose === "stage"
            ? output
            : base.execute(request, signal);
        },
      });
      try {
        const run = host.launch(
          definition.id,
          { context: "Action result defaults" },
          mode,
        );
        const finished = await waitForRun(() => host.store.get(run.id));
        assert.equal(finished.status, "completed", finished.error);
        const expected =
          mode === "selected"
            ? output.summary
            : mode === "parallel"
              ? [output, output]
              : output;
        assert.deepEqual(finished.result, expected);
        assert.deepEqual(
          host.store.readArtifactIfPresent(run.id, "result.json"),
          expected,
        );
        assert.deepEqual(
          host.store.readArtifactIfPresent(run.id, "output.json"),
          stage.agents.map(() => output),
        );
      } finally {
        await host.close();
        fs.rmSync(root, { recursive: true });
      }
    });
  }
});

test("stage restart recovers a stopped missing-receipt attempt without repeating completed work", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = workflow();
  catalog.saveWorkflow(definition);
  const base = fixtureBackend();
  let interrupted = true;
  let directory = "";
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (
        interrupted &&
        request.purpose === "stage" &&
        request.prompt.includes('Execute stage "Report"')
      ) {
        interrupted = false;
        directory = request.directory;
        await executeProcess(
          directory,
          process.execPath,
          ["-e", "console.log('interrupted attempt')"],
          signal,
        );
        fs.unlinkSync(path.join(directory, "exit.json"));
        throw new Error("Supervisor interrupted before receipt");
      }
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const source = host.launch(
      definition.id,
      { context: "Recover only the interrupted stage." },
      "interrupted-source",
    );
    await waitForRun(() => host.store.get(source.id));
    host.resume(source.id);
    const before = await waitForRun(() => host.store.get(source.id));
    assert.equal(before.status, "blocked");
    assert.match(before.error!, /outcome is unknown/);
    const child = host.rerun(source.id, "report", "recovered-stage");
    const finished = await waitForRun(() => host.store.get(child.id));
    assert.equal(finished.status, "completed", finished.error);
    assert.equal(finished.units["discover/alpha"].reusedFrom, source.id);
    assert.equal(finished.units["report/writer"].attempts.length, 1);
    assert.deepEqual(host.store.get(source.id), before);
    assert(!fs.existsSync(path.join(directory, "exit.json")));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, "recovery.json"), "utf8"))
        .status,
      "interrupted-stopped",
    );
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("AI-expanded anyOf schemas pass unchanged to agents and downstream handoffs across recovery", async () => {
  const root = temporaryRoot();
  const store = createRunStore(root);
  const definition = workflow();
  definition.stages[0].agents[0].instructions =
    "Collect Azure DevOps discussions. Return report null; collection does not publish reports.";
  definition.stages[0].outputSchema.properties = {
    summary: { type: "string" },
    report: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      ],
    },
  };
  const expanded = {
    ...definition.stages[0].outputSchema,
    properties: {
      summary: { type: "string" },
      report: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: { path: { type: "string", minLength: 1 } },
            required: ["path"],
          },
        ],
      },
    },
  };
  const base = fixtureBackend();
  const calls: Parameters<AgentBackend["execute"]>[0][] = [];
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      calls.push(request);
      if (request.purpose === "schema" && request.prompt.includes('"Discover"'))
        return expanded;
      if (request.purpose === "stage") {
        if (request.prompt.includes('Execute stage "Discover"')) {
          assert.deepEqual(request.schema, expanded);
          return { summary: "Collected discussions.", report: null };
        }
        assert(
          request.prompt.includes(
            `## Complete accepted handoff schemas\n${JSON.stringify(
              { "discover/alpha": expanded, "discover/beta": expanded },
              null,
              2,
            )}`,
          ),
          "Downstream agents must receive the actual expanded schemas.",
        );
        assert.deepEqual(request.input, { evidence: "Collected discussions." });
      }
      return base.execute(request, signal);
    },
  };
  try {
    const source = store.create(
      definition,
      [],
      { context: "Trust AI schema expansion" },
      "trusted-expansion",
      backend.id,
    );
    await executeRun(store, source.id, backend, new AbortController().signal);
    const completed = store.get(source.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.deepEqual(
      store.readArtifactIfPresent(source.id, "schema-discover.json"),
      expanded,
    );
    const schemaRequest = calls.find(
      (request) => request.purpose === "schema",
    )!;
    assert.match(schemaRequest.prompt, /Collect Azure DevOps discussions/);
    assert.match(schemaRequest.prompt, /collection does not publish reports/);
    calls.length = 0;
    await executeRun(store, source.id, backend, new AbortController().signal);
    assert.equal(store.get(source.id).status, "completed");
    assert.equal(
      calls.length,
      0,
      "Resume must reuse accepted schemas and data.",
    );
    const child = store.create(
      definition,
      [],
      { context: "Trust AI schema expansion" },
      "trusted-expansion-continuation",
      backend.id,
      undefined,
      false,
      {
        continuation: {
          sourceRunId: source.id,
          fromStageId: "report",
          checkpoints: checkpointPrefix(store, source.id, "report"),
          history: {},
        },
      },
    );
    await executeRun(store, child.id, backend, new AbortController().signal);
    const continued = store.get(child.id);
    assert.equal(continued.status, "completed", continued.error);
    assert.equal(calls.length, 2, "Only Report should execute again.");
    assert.deepEqual(continued.result, completed.result);
    store.verify(source.id);
    store.verify(child.id);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("schema-mismatched agent output passes unchanged through handoffs, Resume, and stage reruns", async () => {
  const root = temporaryRoot();
  const store = createRunStore(root);
  const definition = workflow();
  definition.stages[0].agents = [definition.stages[0].agents[0]];
  definition.stages[0].outputSchema.properties = {
    summary: { type: "string" },
    prUrl: { type: "string" },
    openCommentCount: { type: "integer" },
  };
  definition.stages[1].inputs.evidence.pointer = "";
  const output = {
    summary: "The pull request has 2 unresolved review threads.",
    prUrl:
      "https://skype.visualstudio.com/SCC/_git/client-shared_calling_ts-calling/pullrequest/1612177",
    openCommentCount: 2,
  };
  const base = fixtureBackend();
  const calls: Parameters<AgentBackend["execute"]>[0][] = [];
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      calls.push(request);
      if (request.purpose === "schema" && request.prompt.includes('"Discover"'))
        return {
          ...definition.stages[0].outputSchema,
          properties: {
            ...definition.stages[0].outputSchema.properties,
            prUrl: {
              type: "string",
              pattern:
                "^https://[^/]+/[^/]+/[^/]+/pull/[1-9][0-9]*(?:[/?#].*)?$",
            },
          },
        };
      if (request.purpose === "stage") {
        if (request.prompt.includes('Execute stage "Discover"')) return output;
        assert.deepEqual(request.input, { evidence: output });
        assert.match(request.prompt, /pullrequest\/1612177/);
        return { summary: "Received the counter output.", evidence: output };
      }
      return base.execute(request, signal);
    },
  };
  try {
    const source = store.create(
      definition,
      [],
      { context: "Trust the counter result" },
      "trusted-output",
      backend.id,
    );
    await executeRun(store, source.id, backend, new AbortController().signal);
    const completed = store.get(source.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.deepEqual(completed.units["discover/alpha"].output, output);
    assert.equal(calls.length, 4);
    calls.length = 0;
    await executeRun(store, source.id, backend, new AbortController().signal);
    assert.equal(store.get(source.id).status, "completed");
    assert.equal(calls.length, 0, "Resume must reuse accepted results.");
    const child = store.create(
      definition,
      [],
      { context: "Trust the counter result" },
      "trusted-continuation",
      backend.id,
      undefined,
      false,
      {
        continuation: {
          sourceRunId: source.id,
          fromStageId: "report",
          checkpoints: checkpointPrefix(store, source.id, "report"),
          history: {},
        },
      },
    );
    await executeRun(store, child.id, backend, new AbortController().signal);
    const continued = store.get(child.id);
    assert.equal(continued.status, "completed", continued.error);
    assert.deepEqual(continued.units["discover/alpha"].output, output);
    assert.equal(continued.units["discover/alpha"].reusedFrom, source.id);
    assert.equal(calls.length, 2, "Only Report should execute again.");
    assert.deepEqual(continued.result, completed.result);
    store.verify(source.id);
    store.verify(child.id);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("authored output schemas guide agents without rejecting their returned JSON", async () => {
  const root = temporaryRoot();
  const store = createRunStore(root);
  const base = fixtureBackend();
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "stage")
        return { summary: 42, additionalContext: "Keep the original result." };
      return base.execute(request, signal);
    },
  };
  try {
    const run = store.create(
      workflow(),
      [],
      { context: "Schema guidance only" },
      "authored-output-mismatch",
      backend.id,
    );
    await executeRun(store, run.id, backend, new AbortController().signal);
    const completed = store.get(run.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.deepEqual(completed.result, [
      { summary: 42, additionalContext: "Keep the original result." },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("linked Markdown is loaded for fresh runs and remains pinned for Resume and stage reruns", async () => {
  const root = temporaryRoot();
  const file = path.join(root, "writer instructions.md");
  fs.writeFileSync(file, "# Writer\nOriginal linked instructions.");
  const catalog = createCatalog(root);
  const definition = workflow();
  definition.stages[1].agents[0].instructionsFile = file;
  definition.stages[1].agents[0].instructions = "Stale inline instructions.";
  catalog.saveWorkflow(definition);
  const base = fixtureBackend();
  const prompts: string[] = [];
  let blocked = true;
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose === "stage") {
        prompts.push(request.prompt);
        if (blocked && request.prompt.includes('Execute stage "Report"'))
          return { summary: "Needs follow-up.", status: "blocked" };
      }
      return base.execute(request, signal);
    },
  };
  const host = createRunHost(root, catalog, backend);
  try {
    const input = { context: "Linked instructions" };
    const source = host.launch(definition.id, input, "linked-source");
    assert.equal(
      (await waitForRun(() => host.store.get(source.id))).status,
      "blocked",
    );
    assert.equal(
      host.store.snapshot(source.id).workflow.stages[1].agents[0].instructions,
      "# Writer\nOriginal linked instructions.",
    );
    assert(
      prompts.some((prompt) =>
        prompt.includes("Original linked instructions."),
      ),
    );
    assert(
      prompts.every((prompt) => !prompt.includes("Stale inline instructions.")),
    );
    fs.unlinkSync(file);
    assert.equal(
      host.launch(definition.id, input, "linked-source").id,
      source.id,
    );
    prompts.length = 0;
    host.resume(source.id);
    assert.equal(
      (await waitForRun(() => host.store.get(source.id))).status,
      "blocked",
    );
    assert.equal(
      prompts.length,
      0,
      "Resume must reuse the accepted blocked output.",
    );
    blocked = false;
    const child = host.rerun(source.id, "report", "linked-child");
    assert.equal(
      (await waitForRun(() => host.store.get(child.id))).status,
      "completed",
    );
    assert.equal(
      prompts.length,
      1,
      "Only the selected stage agent should execute.",
    );
    assert.match(prompts[0], /Original linked instructions/);
    assert.deepEqual(
      host.store.snapshot(child.id).workflow,
      host.store.snapshot(source.id).workflow,
    );
    const count = host.store.list().length;
    assert.throws(
      () => host.launch(definition.id, input, "missing-file"),
      /Cannot read instructions file.*ENOENT/,
    );
    assert.equal(host.store.list().length, count);
    fs.writeFileSync(file, "# Writer\nUpdated linked instructions.");
    definition.queued = true;
    catalog.saveWorkflow(definition, catalog.workflow(definition.id).revision);
    prompts.length = 0;
    const restarted = host.rerun(
      source.id,
      "report",
      "linked-restart",
      undefined,
      true,
    );
    assert.equal(
      (await waitForRun(() => host.store.get(restarted.id))).status,
      "completed",
    );
    assert.equal(prompts.length, 1);
    assert.equal(restarted.queued, true);
    assert.match(prompts[0], /Updated linked instructions/);
    assert.equal(
      host.store.get(restarted.id).units["discover/alpha"].reusedFrom,
      source.id,
    );
    assert.equal(
      host.rerun(source.id, "report", "linked-restart", undefined, true).id,
      restarted.id,
    );
    assert.throws(
      () => host.rerun(source.id, "report", "linked-restart"),
      /Submission identity/,
    );
    definition.stages[1].agents[0].model = "changed-model";
    catalog.saveWorkflow(definition, catalog.workflow(definition.id).revision);
    assert.throws(
      () =>
        host.rerun(
          source.id,
          "report",
          "incompatible-restart",
          undefined,
          true,
        ),
      /structure or permissions changed/,
    );
    prompts.length = 0;
    const fresh = host.launch(definition.id, input, "linked-fresh");
    assert.equal(
      (await waitForRun(() => host.store.get(fresh.id))).status,
      "completed",
    );
    assert.equal(
      host.store.snapshot(fresh.id).workflow.stages[1].agents[0].instructions,
      "# Writer\nUpdated linked instructions.",
    );
    assert(
      prompts.some((prompt) => prompt.includes("Updated linked instructions.")),
    );
    assert(
      prompts.every(
        (prompt) => !prompt.includes("Original linked instructions."),
      ),
    );
    host.store.verify(source.id);
    host.store.verify(child.id);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accepted blocked or failed outcomes stop stages, preserve sibling evidence, and remain blocked on recovery", async () => {
  for (const [stageId, outcome] of [
    ["discover", "blocked"],
    ["report", "blocked"],
    ["discover", "failed"],
    ["report", "failed"],
  ]) {
    const root = temporaryRoot();
    const store = createRunStore(root);
    const definition = workflow();
    definition.stages[0].outputSchema.properties = {
      summary: { type: "string" },
      status: { type: "string" },
    };
    const blockedStage = definition.stages.find(
      (stage) => stage.id === stageId,
    )!;
    const base = fixtureBackend();
    let calls = 0;
    const backend: AgentBackend = {
      ...base,
      async execute(request, signal) {
        calls++;
        if (request.purpose === "stage") {
          const blocked =
            request.prompt.includes(`Execute stage "${blockedStage.name}"`) &&
            request.prompt.includes(`You are ${blockedStage.agents[0].name}.`);
          return {
            summary: blocked ? "Required workspace lock is missing." : "Ready.",
            status: blocked ? outcome : "completed",
          };
        }
        return base.execute(request, signal);
      },
    };
    try {
      const run = store.create(
        definition,
        [],
        { context: "Business blocker" },
        `${outcome}-${stageId}`,
        backend.id,
      );
      await executeRun(store, run.id, backend, new AbortController().signal);
      const blocked = store.get(run.id);
      assert.equal(blocked.status, "blocked", blocked.error);
      assert.equal(blocked.currentStage, stageId);
      assert.match(
        blocked.error!,
        new RegExp(`reported status "${outcome}".*rerun`),
      );
      assert.match(blocked.error!, new RegExp(blockedStage.name));
      assert.equal(calls, stageId === "discover" ? 3 : 5);
      for (const agent of blockedStage.agents) {
        const unit = blocked.units[`${stageId}/${agent.id}`];
        assert.equal(unit.status, "completed");
        assert.equal(unit.attempts[0].status, "completed");
        assert(unit.output);
      }
      if (stageId === "discover") {
        assert.deepEqual(blocked.units["discover/beta"].output, {
          summary: "Ready.",
          status: "completed",
        });
        assert.equal(blocked.units["@schema/report"], undefined);
        assert.equal(blocked.units["report/writer"], undefined);
        assert.equal(
          store.readArtifactIfPresent(run.id, "schema-report.json"),
          undefined,
        );
      }
      assert.equal(blocked.result, undefined);
      for (const name of ["output.json", "result.json"])
        assert.equal(store.readArtifactIfPresent(run.id, name), undefined);
      calls = 0;
      const recoveredStore = createRunStore(root);
      await executeRun(
        recoveredStore,
        run.id,
        backend,
        new AbortController().signal,
      );
      const recovered = recoveredStore.get(run.id);
      assert.equal(recovered.status, "blocked");
      assert.equal(recovered.currentStage, stageId);
      assert.equal(recovered.error, blocked.error);
      assert.deepEqual(recovered.units, blocked.units);
      assert.equal(
        calls,
        0,
        "Resume must not bypass or regenerate the blocker",
      );
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

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

test("generated Draft 2020-12 contracts complete and resume alongside Draft-07 stages", async () => {
  const root = temporaryRoot();
  const catalog = createCatalog(root);
  const definition = workflow();
  definition.inputSchema.$schema =
    "https://json-schema.org/draft/2020-12/schema";
  definition.stages[1].outputSchema.$schema =
    "http://json-schema.org/draft-07/schema#";
  const base = fixtureBackend();
  let calls = 0;
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      calls++;
      const output = await base.execute(request, signal);
      if (request.purpose === "schema" && request.prompt.includes('"Discover"'))
        return {
          ...definition.stages[0].outputSchema,
          $schema: "https://json-schema.org/draft/2020-12/schema",
        };
      return output;
    },
  };
  let host: ReturnType<typeof createRunHost> | undefined;
  try {
    catalog.saveWorkflow(definition);
    host = createRunHost(root, catalog, backend);
    const run = host.launch(
      "sample",
      { context: "Mixed schema dialects" },
      "schema-dialects",
    );
    const result = await waitForRun(() => host!.store.get(run.id));
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.units["@schema/discover"].status, "completed");
    assert.equal(result.units["report/writer"].status, "completed");
    const interrupted = host.store.get(run.id);
    interrupted.status = "blocked";
    host.store.save(interrupted);
    calls = 0;
    host.resume(run.id);
    const resumed = await waitForRun(() => host!.store.get(run.id));
    assert.equal(resumed.status, "completed", resumed.error);
    assert.equal(calls, 0);
  } finally {
    await host?.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("dialect-aware validation enforces 2020-12 keywords and retains Draft-07 tuple semantics", () => {
  const base = {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  };
  const expanded = {
    ...base,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    unevaluatedProperties: false,
  };
  validateJson(expanded, { summary: "Evidence" });
  assert.throws(
    () => validateJson(expanded, { summary: "Evidence", unexpected: true }),
    /unevaluated properties/,
  );
  assert.throws(() => validateJson(expanded, {}), /summary/);
  const tuple = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "array",
    items: [{ type: "string" }],
    additionalItems: false,
  };
  validateJson(tuple, ["Evidence"]);
  assert.throws(() => validateJson(tuple, ["Evidence", "Extra"]), /items/);
});

test("JSON validation supports conditional allOf approval gates", () => {
  const approvalGate = {
    if: { properties: { approved: { const: true } } },
    then: {
      required: ["coverageComplete"],
      properties: { coverageComplete: { const: true } },
    },
  };
  const base = {
    type: "object",
    properties: {
      approved: { type: "boolean" },
      coverageComplete: { type: "boolean" },
      evidence: { type: "array", items: { type: "string" } },
    },
    required: ["approved", "evidence"],
    allOf: [approvalGate],
  };
  const expanded = {
    ...base,
    allOf: [
      {
        ...approvalGate,
        then: {
          ...approvalGate.then,
          properties: {
            ...approvalGate.then.properties,
            evidence: { minItems: 1 },
          },
        },
      },
      {
        if: {
          properties: { coverageComplete: { const: true } },
          required: ["coverageComplete"],
        },
        then: { properties: { evidence: { minItems: 1 } } },
      },
    ],
  };
  validateJson(expanded, {
    approved: true,
    coverageComplete: true,
    evidence: ["Reviewed"],
  });
  validateJson(expanded, { approved: false, evidence: [] });
  assert.throws(() =>
    validateJson(expanded, {
      approved: true,
      coverageComplete: false,
      evidence: ["Reviewed"],
    }),
  );
  assert.throws(() =>
    validateJson(expanded, { approved: true, evidence: ["Reviewed"] }),
  );
  assert.throws(() =>
    validateJson(expanded, {
      approved: true,
      coverageComplete: true,
      evidence: [],
    }),
  );
});

test("long-running agents and summaries have no deadline while stop and shutdown still cancel", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  // Native AbortSignal timers do not use Node's mocked setTimeout clock.
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    const abort = new AbortController();
    setTimeout(
      () => abort.abort(new Error("Agent deadline elapsed")),
      milliseconds,
    );
    return abort.signal;
  });
  for (const action of ["complete", "stop", "shutdown"]) {
    const root = temporaryRoot();
    const catalog = createCatalog(root);
    const definition = workflow();
    definition.stages[0].agents = [definition.stages[0].agents[0]];
    catalog.saveWorkflow(definition);
    let markStageStarted!: () => void;
    const stageStarted = new Promise<void>((resolve) => {
      markStageStarted = resolve;
    });
    let releaseStage = () => {};
    let markSummaryStarted!: () => void;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const backend: AgentBackend = {
      id: "long-running-fixture",
      diagnostics: () => ({ available: true }),
      async execute(request, signal) {
        signal.throwIfAborted();
        if (request.purpose === "schema") return request.input;
        if (request.purpose === "summary") {
          if (action === "complete") {
            markSummaryStarted();
            await summaryGate;
            signal.throwIfAborted();
          }
          return {
            lines: ["Fixture work finished.", "No external actions ran."],
          };
        }
        if (request.prompt.includes('Execute stage "Discover"')) {
          await new Promise<void>((resolve, reject) => {
            const cancel = () => reject(signal.reason);
            releaseStage = () => {
              signal.removeEventListener("abort", cancel);
              resolve();
            };
            signal.addEventListener("abort", cancel, { once: true });
            markStageStarted();
          });
        }
        signal.throwIfAborted();
        return { summary: "Long-running fixture output" };
      },
    };
    const host = createRunHost(root, catalog, backend);
    try {
      const run = host.launch(
        definition.id,
        { context: "Keep working past the old deadline" },
        `no-deadline-${action}`,
      );
      await stageStarted;
      context.mock.timers.tick(31 * 60 * 1000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(host.store.get(run.id).status, "running", action);
      if (action === "complete") {
        releaseStage();
        await summaryStarted;
        assert.equal(host.store.get(run.id).status, "completed");
        context.mock.timers.tick(3 * 60 * 1000);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(host.summaries.read(run.id)?.status, "generating");
        releaseSummary();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(host.summaries.read(run.id)?.status, "completed");
      } else {
        if (action === "stop") host.stop(run.id);
        else await host.close();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(host.store.get(run.id).status, "cancelled", action);
      }
    } finally {
      releaseStage();
      releaseSummary();
      await host.close();
      fs.rmSync(root, { recursive: true });
    }
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
      if (request.purpose !== "summary") {
        permissions.push(request.allowAllTools ?? false);
        grantedFolders.push({
          purpose: request.purpose,
          prompt: request.prompt,
          folders: request.allowedFolders ?? [],
        });
      }
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
      if (request.purpose !== "summary")
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

test("tampered artifacts fail closed", async () => {
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
