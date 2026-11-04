import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  Json,
  Schema,
  Skill,
  Stage,
  Workflow,
} from "../shared/contracts.ts";
import { validateReferences } from "../shared/bindings.ts";

const createAjv = (schema: Schema) => {
  const Validator =
    schema.$schema === "https://json-schema.org/draft/2020-12/schema"
      ? Ajv2020
      : Ajv;
  return new Validator({
    strict: false,
    allErrors: true,
    validateSchema: true,
  });
};
export function validateJson(schema: Schema, value: Json): void {
  const ajv = createAjv(schema);
  const check = ajv.compile(schema);
  if (!check(value))
    throw Object.assign(
      new Error(ajv.errorsText(check.errors, { separator: "; " })),
      { status: 400 },
    );
}

export function assertStageNotBlocked(
  stage: Stage,
  outputs: Record<string, Json>,
): void {
  const blocked = stage.agents.filter((agent) => {
    const output = outputs[`${stage.id}/${agent.id}`];
    return (
      output !== null &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      output.status === "blocked"
    );
  });
  if (blocked.length)
    throw Object.assign(
      new Error(
        `${stage.name}: ${blocked.map((agent) => agent.name).join(", ")} reported status "blocked". Resolve the blockers and rerun from "${stage.name}"; Resume reuses accepted outputs.`,
      ),
      { status: 409 },
    );
}

export function validateWorkflow(workflow: Workflow, skills: Skill[]): void {
  createAjv(workflow.inputSchema).compile(workflow.inputSchema);
  validateReferences(workflow);
  const ids = new Set(skills.map((skill) => skill.id));
  for (const stage of workflow.stages) {
    createAjv(stage.outputSchema).compile(stage.outputSchema);
    const requested = [
      ...stage.skills,
      ...stage.agents.flatMap((agent) => agent.skills),
    ];
    for (const id of requested)
      if (!ids.has(id)) throw new Error(`Unknown skill: ${id}`);
  }
}
