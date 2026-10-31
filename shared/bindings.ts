import type { Json, Reference, Workflow } from "./contracts.ts";

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
): Json {
  if (ref.source === "literal") return ref.value;
  if (ref.source === "input") return pointer(input, ref.pointer);
  if (ref.source === "trigger") {
    if (trigger === undefined)
      throw new Error("Trigger binding is unavailable in this context");
    return pointer(trigger, ref.pointer);
  }
  const key = `${ref.stageId}/${ref.agentId}`;
  if (!Object.hasOwn(outputs, key))
    throw new Error(`Output unavailable: ${key}`);
  return pointer(outputs[key], ref.pointer);
}

export function validateReferences(workflow: Workflow): void {
  const available = new Set<string>();
  for (const stage of workflow.stages) {
    if (available.has(`stage:${stage.id}`))
      throw new Error(`Duplicate stage: ${stage.id}`);
    for (const ref of Object.values(stage.inputs)) validate(ref, available);
    const agents = new Set<string>();
    for (const agent of stage.agents) {
      if (agents.has(agent.id))
        throw new Error(`Duplicate agent in ${stage.id}: ${agent.id}`);
      agents.add(agent.id);
    }
    available.add(`stage:${stage.id}`);
    for (const agent of stage.agents) available.add(`${stage.id}/${agent.id}`);
  }
  if (workflow.result) validate(workflow.result, available);
}

function validate(ref: Reference, available: Set<string>): void {
  if (ref.source === "trigger")
    throw new Error(
      "Workflow bindings cannot reference watcher triggers directly",
    );
  if (
    ref.source !== "literal" &&
    ref.pointer !== "" &&
    (!ref.pointer.startsWith("/") || /~(?![01])/u.test(ref.pointer))
  ) {
    throw new Error(`Invalid JSON Pointer: ${ref.pointer}`);
  }
  if (
    ref.source === "stage" &&
    !available.has(`${ref.stageId}/${ref.agentId}`)
  ) {
    throw new Error(
      `Binding must reference an earlier stage and explicit agent: ${ref.stageId}/${ref.agentId}`,
    );
  }
}
