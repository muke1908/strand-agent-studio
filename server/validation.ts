import type { Json, Skill, Stage, Workflow } from "../shared/contracts.ts";
import { validateReferences } from "../shared/bindings.ts";
import { createJsonValidator } from "../shared/json-schema.ts";

export { validateJson } from "../shared/json-schema.ts";

export function assertStageNotBlocked(
  stage: Stage,
  outputs: Record<string, Json>,
): void {
  const failures = stage.agents.flatMap((agent) => {
    const output = outputs[`${stage.id}/${agent.id}`];
    return output !== null &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      (output.status === "blocked" || output.status === "failed")
      ? [`${agent.name} reported status "${output.status}"`]
      : [];
  });
  if (failures.length)
    throw Object.assign(
      new Error(
        `${stage.name}: ${failures.join(", ")}. Resolve the issues and rerun from "${stage.name}"; Resume reuses accepted outputs.`,
      ),
      { status: 409 },
    );
}

export function validateWorkflow(workflow: Workflow, skills: Skill[]): void {
  createJsonValidator(workflow.inputSchema).compile(workflow.inputSchema);
  validateReferences(workflow);
  const ids = new Set(skills.map((skill) => skill.id));
  for (const stage of workflow.stages) {
    createJsonValidator(stage.outputSchema).compile(stage.outputSchema);
    const requested = [
      ...stage.skills,
      ...stage.agents.flatMap((agent) => agent.skills),
    ];
    for (const id of requested)
      if (!ids.has(id)) throw new Error(`Unknown skill: ${id}`);
  }
}
