import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { Json, Reference, Workflow } from "../shared/contracts.ts";
import { workflowSchema } from "../shared/contracts.ts";
import { resolveReference, validateReferences } from "../shared/bindings.ts";
import type { AgentBackend, AgentRequest } from "../server/agent-backend.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import { createRunStore } from "../server/run-store.ts";
import { executeRun } from "../server/run-engine.ts";
import { checkpointPrefix } from "../server/run-checkpoint.ts";
import { unitDetails } from "../server/unit-details.ts";
import { digest } from "../server/files.ts";
import { loopMatches } from "../server/loops.ts";
import { runAssets } from "../server/run-assets.ts";
import { temporaryRoot, workflow } from "./helpers.ts";

function definition(): Workflow {
  const base = workflow();
  const stage = base.stages[0];
  return {
    ...base,
    stages: [
      {
        ...stage,
        id: "prepare",
        name: "Prepare",
        agents: [{ ...stage.agents[0], id: "setup" }],
      },
      {
        ...stage,
        id: "transform",
        name: "Transform",
        agents: [{ ...stage.agents[0], id: "worker" }],
        inputs: {
          seed: {
            source: "stage",
            stageId: "prepare",
            agentId: "setup",
            pointer: "/summary",
          },
          feedback: { source: "loop", pointer: "/feedback" },
        },
      },
      {
        ...stage,
        id: "measure",
        name: "Measure",
        agents: [{ ...stage.agents[0], id: "meter" }],
        inputs: {
          evidence: {
            source: "stage",
            stageId: "transform",
            agentId: "worker",
            pointer: "/summary",
          },
        },
        loop: {
          targetStageId: "transform",
          condition: {
            agentId: "meter",
            pointer: "/errorCount",
            operator: "greaterThan",
            value: 0,
          },
          maxIterations: 3,
          feedback: {
            notes: {
              source: "stage",
              stageId: "measure",
              agentId: "meter",
              pointer: "/notes",
            },
          },
        },
      },
      {
        ...base.stages[1],
        id: "ship",
        name: "Ship",
        inputs: {
          evidence: {
            source: "stage",
            stageId: "measure",
            agentId: "meter",
            pointer: "/summary",
          },
        },
      },
    ],
  };
}

function fixture(
  t: TestContext,
  respond: (
    stage: string,
    pass: number,
    request: AgentRequest,
  ) => Json | Promise<Json> = (stage, pass, request) => {
    if (stage === "measure")
      return {
        summary: `measurement-${pass}`,
        errorCount: pass === 1 ? 1 : 0,
        notes: ["Change the value"],
      };
    if (stage === "transform") return { summary: `value-${pass}` };
    return { summary: stage, input: request.input };
  },
  value = definition(),
) {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true }));
  const store = createRunStore(root);
  const calls: AgentRequest[] = [];
  const counts = new Map<string, number>();
  const base = fixtureBackend();
  const backend: AgentBackend = {
    ...base,
    async execute(request, signal) {
      if (request.purpose !== "stage") return base.execute(request, signal);
      calls.push(request);
      const [stage, agent] = path.basename(request.directory).split("-");
      const key = `${stage}/${agent}`;
      const pass = (counts.get(key) ?? 0) + 1;
      counts.set(key, pass);
      return respond(stage, pass, request);
    },
  };
  const run = store.create(
    value,
    [],
    { context: "Generic cycle" },
    "cycle",
    backend.id,
  );
  const execute = (id = run.id, signal = new AbortController().signal) =>
    executeRun(store, id, backend, signal);
  return { store, run, calls, counts, backend, execute };
}

test("generic loop passes feedback, executes fresh visits, and continues with only final handoffs", async (t) => {
  const { store, run, calls, counts, execute } = fixture(t);
  await execute();
  const completed = store.get(run.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.deepEqual(Object.fromEntries(counts), {
    "prepare/setup": 1,
    "transform/worker": 2,
    "measure/meter": 2,
    "ship/writer": 1,
  });
  assert.equal(completed.visits?.length, 6);
  assert.equal(completed.visits?.[2].route?.kind, "repeat");
  assert.equal(completed.visits?.[4].route?.kind, "continue");
  assert.equal(
    completed.visits?.[3].units["transform/worker"].attempts.length,
    1,
  );
  assert.deepEqual(calls[3].input, {
    seed: "prepare",
    feedback: { notes: ["Change the value"] },
  });
  assert.doesNotMatch(calls[3].prompt, /"measure\/meter":/);
  assert.match(calls[3].prompt, /"iteration": 2/);
  assert.deepEqual(calls.at(-1)?.input, { evidence: "measurement-2" });
  assert.deepEqual(
    unitDetails(store, run.id, "visit-2:transform/worker").input.stageInput,
    { seed: "prepare", feedback: null },
  );
  assert.deepEqual(
    unitDetails(store, run.id, "visit-4:transform/worker").input.stageInput,
    calls[3].input,
  );
  assert.deepEqual(unitDetails(store, run.id, "transform/worker").output, {
    summary: "value-2",
  });
  const count = calls.length;
  await execute();
  assert.equal(
    calls.length,
    count,
    "Replay must not repeat accepted side effects",
  );
  assert.equal(store.get(run.id).status, "completed");
  const assets = unzipSync(runAssets(store, run.id));
  assert.equal(
    JSON.parse(strFromU8(assets["execution/state.json"])).visits.length,
    6,
  );
  assert.deepEqual(
    JSON.parse(strFromU8(assets["execution/input-visit-4.json"])).stageInput,
    calls[3].input,
  );
  store.verify(run.id);
});

test("a nonmatching first pass continues immediately, while a one-pass matching limit never repeats", async (t) => {
  for (const errorCount of [0, 1]) {
    await t.test(`errorCount ${errorCount}`, async (t) => {
      const value = definition();
      value.stages[2].loop!.maxIterations = 1;
      const { store, run, counts, execute } = fixture(
        t,
        (stage) =>
          stage === "measure"
            ? { summary: "Measured", errorCount, notes: [] }
            : { summary: stage },
        value,
      );
      await execute();
      assert.equal(
        store.get(run.id).status,
        errorCount ? "blocked" : "completed",
      );
      assert.equal(counts.get("transform/worker"), 1);
      assert.equal(counts.get("ship/writer"), errorCount ? undefined : 1);
    });
  }
});

test("matching at the total-pass limit blocks downstream work and Resume cannot reset the budget", async (t) => {
  const value = definition();
  value.stages[2].loop!.maxIterations = 2;
  const { store, run, calls, execute } = fixture(
    t,
    (stage) =>
      stage === "measure"
        ? { errorCount: 1, notes: ["Still unresolved"] }
        : { summary: stage },
    value,
  );
  await execute();
  const blocked = store.get(run.id);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.error!, /maximum of 2 total passes/);
  assert.equal(blocked.visits?.at(-1)?.route?.kind, "limit");
  assert.equal(blocked.units["ship/writer"], undefined);
  assert.throws(
    () => checkpointPrefix(store, run.id, "ship"),
    /loop has not exited/,
  );
  const count = calls.length;
  await execute();
  assert.equal(calls.length, count);
  assert.match(store.get(run.id).error!, /maximum of 2/);
});

test("missing and mistyped routing fields block explicitly rather than approve or repeat", async (t) => {
  for (const output of [
    { notes: [] },
    { errorCount: "0" },
    { errorCount: null },
  ]) {
    await t.test(JSON.stringify(output), async (t) => {
      const { store, run, counts, execute } = fixture(t, (stage) =>
        stage === "measure" ? output : { summary: stage },
      );
      await execute();
      const blocked = store.get(run.id);
      assert.equal(blocked.status, "blocked");
      assert.match(blocked.error!, /Missing binding value|has type/);
      assert.equal(counts.get("ship/writer"), undefined);
      assert.equal(counts.get("transform/worker"), 1);
    });
  }
});

test("Stop and Resume retry only interrupted work within the correct pass", async (t) => {
  const controller = new AbortController();
  const { store, run, counts, execute } = fixture(t, (stage, pass) => {
    if (stage === "transform" && pass === 2) {
      controller.abort(new Error("Owner stopped"));
      throw controller.signal.reason;
    }
    if (stage === "measure")
      return {
        summary: `measurement-${pass}`,
        errorCount: pass === 1 ? 1 : 0,
        notes: ["Change"],
      };
    return { summary: stage };
  });
  await execute(run.id, controller.signal);
  assert.equal(store.get(run.id).status, "cancelled");
  const interruptedUnits = store.get(run.id).units;
  await execute(run.id, controller.signal);
  assert.deepEqual(
    store.get(run.id).units,
    interruptedUnits,
    "An already-cancelled Resume must retain the latest accepted view",
  );
  await execute();
  const resumed = store.get(run.id);
  assert.equal(resumed.status, "completed", resumed.error);
  assert.equal(counts.get("prepare/setup"), 1);
  assert.equal(counts.get("transform/worker"), 3);
  assert.equal(counts.get("measure/meter"), 2);
  assert.equal(resumed.visits?.[3].iteration, 2);
  assert.equal(
    resumed.visits?.[3].units["transform/worker"].attempts.length,
    2,
  );
});

test("recovery on either side of route persistence does not replay completed agents", async (t) => {
  for (const point of ["artifact", "state"]) {
    await t.test(point, async (t) => {
      const { store, run, counts, execute } = fixture(t);
      let interrupted = false;
      if (point === "artifact") {
        const artifact = store.artifact;
        store.artifact = (id, name, value) => {
          artifact(id, name, value);
          if (!interrupted && name === "route-visit-3.json") {
            interrupted = true;
            throw new Error("Crash after route commit");
          }
        };
      } else {
        const save = store.save;
        store.save = (value) => {
          save(value);
          if (
            !interrupted &&
            value.visits?.some((visit) => visit.route?.kind === "repeat")
          ) {
            interrupted = true;
            throw new Error("Crash after route state commit");
          }
        };
      }
      await execute();
      assert.equal(store.get(run.id).status, "blocked");
      await execute();
      const resumed = store.get(run.id);
      assert.equal(resumed.status, "completed", resumed.error);
      assert.equal(counts.get("transform/worker"), 2);
      assert.equal(counts.get("measure/meter"), 2);
      assert.equal(resumed.visits?.length, 6);
    });
  }
});

test("parallel stage selects the configured agent, and disjoint self-loop budgets are independent", async (t) => {
  const value = definition();
  value.stages[2].agents.unshift({
    ...value.stages[2].agents[0],
    id: "observer",
  });
  value.stages[3].loop = {
    targetStageId: "ship",
    condition: {
      agentId: "writer",
      pointer: "/pending",
      operator: "equals",
      value: true,
    },
    feedback: {},
    maxIterations: 2,
  };
  const { store, run, counts, execute } = fixture(
    t,
    (stage, pass, request) => {
      if (path.basename(request.directory).includes("-observer-"))
        return { errorCount: 999 };
      if (stage === "measure")
        return {
          summary: "measurement",
          errorCount: pass === 1 ? 1 : 0,
          notes: [],
        };
      return { summary: stage, pending: stage === "ship" && pass === 1 };
    },
    value,
  );
  await execute();
  const completed = store.get(run.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(counts.get("prepare/setup"), 1);
  assert.equal(counts.get("transform/worker"), 2);
  assert.equal(counts.get("ship/writer"), 2);
});

test("reruns inherit coherent final-pass checkpoints but repeated stages never reuse the inherited prefix twice", async (t) => {
  let repeat = false;
  const { store, run, counts, backend, execute } = fixture(t, (stage, pass) => {
    if (stage === "measure")
      return {
        summary: `measurement-${pass}`,
        errorCount: pass === 1 || repeat ? 1 : 0,
        notes: ["Correct"],
      };
    return { summary: `${stage}-${pass}` };
  });
  await execute();
  const sourceDigest = digest(store.get(run.id));
  const create = (fromStageId: string) =>
    store.create(
      store.snapshot(run.id).workflow,
      [],
      store.snapshot(run.id).input,
      `child-${fromStageId}`,
      backend.id,
      undefined,
      false,
      {
        continuation: {
          sourceRunId: run.id,
          fromStageId,
          checkpoints: checkpointPrefix(store, run.id, fromStageId),
          history: {},
        },
      },
    );
  const tail = create("ship");
  await execute(tail.id);
  assert.equal(
    store.get(tail.id).status,
    "completed",
    store.get(tail.id).error,
  );
  assert.equal(counts.get("transform/worker"), 2);
  assert.equal(counts.get("measure/meter"), 2);
  repeat = true;
  const middle = create("measure");
  await execute(middle.id);
  const blocked = store.get(middle.id);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.error!, /maximum of 3/);
  assert.equal(counts.get("prepare/setup"), 1);
  assert.equal(
    counts.get("transform/worker"),
    4,
    "Initial inherited transform is reused only once, then executed twice afresh",
  );
  assert.equal(
    blocked.visits?.[1].units["transform/worker"].reusedFrom,
    run.id,
  );
  assert.equal(
    blocked.visits?.[3].units["transform/worker"].reusedFrom,
    undefined,
  );
  assert.equal(digest(store.get(run.id)), sourceDigest);
});

test("owner-skipped loop closure bypasses routing explicitly without requiring its condition field", async (t) => {
  const { store, run, backend, counts, execute } = fixture(t);
  await execute();
  const child = store.create(
    store.snapshot(run.id).workflow,
    [],
    store.snapshot(run.id).input,
    "skip-loop",
    backend.id,
    undefined,
    false,
    {
      continuation: {
        sourceRunId: run.id,
        fromStageId: "measure",
        checkpoints: checkpointPrefix(store, run.id, "measure"),
        history: {},
      },
      stageSkips: [
        {
          stageId: "measure",
          reason: "Owner bypass for this case",
          at: new Date().toISOString(),
          allowPublication: false,
        },
      ],
    },
  );
  await execute(child.id);
  const completed = store.get(child.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(completed.visits?.[2].route?.kind, "skipped");
  assert.equal(completed.units["measure/meter"].attempts.length, 0);
  assert.equal(counts.get("measure/meter"), 2);
});

test("loop validation preserves normal dependency rules and rejects unsafe ranges and conditions", () => {
  const value = definition();
  validateReferences(value);
  for (const change of [
    (value: Workflow) => {
      value.stages[2].loop!.targetStageId = "ship";
    },
    (value: Workflow) => {
      value.stages[2].loop!.condition.agentId = "writer";
    },
    (value: Workflow) => {
      value.stages[2].loop!.condition.pointer = "not-a-pointer";
    },
    (value: Workflow) => {
      value.stages[2].loop!.condition.value = "0";
    },
    (value: Workflow) => {
      value.stages[0].inputs.feedback = {
        source: "loop",
        pointer: "/feedback",
      };
    },
    (value: Workflow) => {
      value.stages[1].inputs.future = {
        source: "stage",
        stageId: "measure",
        agentId: "meter",
        pointer: "",
      };
    },
    (value: Workflow) => {
      value.stages[3].loop = {
        ...value.stages[2].loop!,
        condition: { ...value.stages[2].loop!.condition, agentId: "writer" },
      };
    },
  ]) {
    const invalid = structuredClone(value);
    change(invalid);
    assert.throws(() => validateReferences(invalid));
  }
  for (const maxIterations of [0, 21, 1.5]) {
    const invalid = structuredClone(value);
    invalid.stages[2].loop!.maxIterations = maxIterations;
    assert.throws(() => workflowSchema.parse(invalid));
  }
  const legacy = workflow();
  assert.deepEqual(workflowSchema.parse(legacy), legacy);
  assert.equal(
    Object.hasOwn(workflowSchema.parse(legacy).stages[0], "loop"),
    false,
  );
  const ref: Reference = {
    source: "loop",
    pointer: "/feedback/notes",
    default: [],
  };
  assert.deepEqual(
    resolveReference(ref, null, {}, undefined, {
      stageId: "measure",
      iteration: 1,
      maxIterations: 3,
      feedback: null,
    }),
    [],
  );
  assert.throws(
    () =>
      resolveReference(ref, null, {}, undefined, {
        stageId: "measure",
        iteration: 2,
        maxIterations: 3,
        feedback: {},
      }),
    /Missing binding value/,
  );
});

test("conditions compare JSON structurally and numeric operators without coercion", () => {
  const stage = definition().stages[2];
  stage.loop!.condition = {
    agentId: "meter",
    pointer: "/value",
    operator: "equals",
    value: { a: 1, b: [2] },
  };
  assert.equal(
    loopMatches(stage, { "measure/meter": { value: { b: [2], a: 1 } } })
      .matches,
    true,
  );
  for (const [operator, expected] of [
    ["greaterThan", false],
    ["greaterThanOrEqual", true],
    ["lessThan", false],
    ["lessThanOrEqual", true],
    ["notEquals", false],
  ] as const) {
    stage.loop!.condition = { ...stage.loop!.condition, operator, value: 2 };
    assert.equal(
      loopMatches(stage, { "measure/meter": { value: 2 } }).matches,
      expected,
    );
  }
  assert.throws(
    () => loopMatches(stage, { "measure/meter": { value: "2" } }),
    /has type string/,
  );
});
