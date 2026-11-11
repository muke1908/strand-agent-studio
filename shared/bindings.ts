import type {
  Json,
  LoopContext,
  Reference,
  Stage,
  Workflow,
} from "./contracts.ts";

export function pointer(value: Json, path: string): Json {
  if (path === "") return value;
  if (!path.startsWith("/") || /~(?![01])/u.test(path))
    throw new Error(`Invalid JSON Pointer: ${path}`);
  let current = value;
  for (const part of path.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    ) {
      throw new Error(`Missing binding value: ${path}`);
    }
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key))
        throw new Error(`Invalid array binding: ${path}`);
      current = current[Number(key)];
    } else current = current[key];
  }
  return current;
}

export function resolveReference(
  ref: Reference,
  input: Json,
  outputs: Record<string, Json>,
  trigger?: Json,
  loopContext?: LoopContext,
): Json {
  if (ref.source === "literal") return ref.value;
  if (ref.source === "input") return pointer(input, ref.pointer);
  if (ref.source === "trigger") {
    if (trigger === undefined)
      throw new Error("Trigger binding is unavailable in this context");
    return pointer(trigger, ref.pointer);
  }
  if (ref.source === "loop") {
    if (!loopContext) throw new Error("Loop feedback is unavailable here");
    if (
      loopContext.iteration === 1 &&
      loopContext.feedback === null &&
      ref.default !== undefined
    )
      return ref.default;
    return pointer(loopContext, ref.pointer);
  }
  const key = `${ref.stageId}/${ref.agentId}`;
  if (!Object.hasOwn(outputs, key))
    throw new Error(`Output unavailable: ${key}`);
  return pointer(outputs[key], ref.pointer);
}

export function stageOutput(stage: Stage, outputs: Record<string, Json>): Json {
  const results = Object.fromEntries(
    stage.agents.map((agent) => [
      agent.id,
      resolveReference(
        { source: "stage", stageId: stage.id, agentId: agent.id, pointer: "" },
        null,
        outputs,
      ),
    ]),
  );
  return stage.agents.length === 1 ? results[stage.agents[0].id] : results;
}

export function resolveStageInput(
  workflow: Workflow,
  stage: Stage,
  input: Json,
  outputs: Record<string, Json>,
  loopContext?: LoopContext,
): Json {
  if (stage.expectedOutput !== undefined) {
    if (
      loopContext &&
      loopContext.iteration > 1 &&
      workflow.stages.find((item) => item.id === loopContext.stageId)?.loop
        ?.targetStageId === stage.id
    )
      return loopContext.feedback;
    const index = workflow.stages.findIndex((item) => item.id === stage.id);
    if (index < 0) throw new Error(`Unknown stage: ${stage.id}`);
    return index === 0
      ? input
      : stageOutput(workflow.stages[index - 1], outputs);
  }
  return Object.fromEntries(
    Object.entries(stage.inputs).map(([name, ref]) => [
      name,
      resolveReference(ref, input, outputs, undefined, loopContext),
    ]),
  );
}

export function validateReferences(workflow: Workflow): void {
  const ranges = workflow.stages.flatMap((stage, end) => {
    if (!stage.loop) return [];
    const start = workflow.stages.findIndex(
      (item) => item.id === stage.loop!.targetStageId,
    );
    if (start < 0 || start > end)
      throw new Error(
        `Loop in ${stage.name} must target itself or an earlier stage`,
      );
    if (
      !stage.agents.some((agent) => agent.id === stage.loop!.condition.agentId)
    )
      throw new Error(
        `Loop in ${stage.name} must select an agent from that stage`,
      );
    const { pointer: path, operator, value } = stage.loop.condition;
    validatePointer(path);
    if (
      operator !== "equals" &&
      operator !== "notEquals" &&
      typeof value !== "number"
    )
      throw new Error(
        `Numeric loop comparison in ${stage.name} needs a number`,
      );
    return [{ start, end }];
  });
  for (let index = 1; index < ranges.length; index++)
    if (ranges[index].start <= ranges[index - 1].end)
      throw new Error("Loop ranges must not overlap or nest");
  const available = new Set<string>();
  for (const [index, stage] of workflow.stages.entries()) {
    if (available.has(`stage:${stage.id}`))
      throw new Error(`Duplicate stage: ${stage.id}`);
    const inLoop = ranges.some(
      ({ start, end }) => start <= index && index <= end,
    );
    if (stage.expectedOutput === undefined)
      for (const ref of Object.values(stage.inputs))
        validate(ref, available, inLoop);
    const agents = new Set<string>();
    for (const agent of stage.agents) {
      if (agents.has(agent.id))
        throw new Error(`Duplicate agent in ${stage.id}: ${agent.id}`);
      agents.add(agent.id);
    }
    available.add(`stage:${stage.id}`);
    for (const agent of stage.agents) available.add(`${stage.id}/${agent.id}`);
    if (stage.expectedOutput === undefined)
      for (const ref of Object.values(stage.loop?.feedback ?? {}))
        validate(ref, available, inLoop);
  }
  if (workflow.result) validate(workflow.result, available);
}

export function validatePointer(path: string): void {
  if (path !== "" && (!path.startsWith("/") || /~(?![01])/u.test(path)))
    throw new Error(`Invalid JSON Pointer: ${path}`);
}

function validate(
  ref: Reference,
  available: Set<string>,
  inLoop = false,
): void {
  if (ref.source === "trigger")
    throw new Error(
      "Workflow bindings cannot reference watcher triggers directly",
    );
  if (ref.source !== "literal") validatePointer(ref.pointer);
  if (ref.source === "loop" && !inLoop)
    throw new Error("Loop feedback bindings must be inside a loop range");
  if (
    ref.source === "stage" &&
    !available.has(`${ref.stageId}/${ref.agentId}`)
  ) {
    throw new Error(
      `Binding must reference an earlier stage and explicit agent: ${ref.stageId}/${ref.agentId}`,
    );
  }
}
