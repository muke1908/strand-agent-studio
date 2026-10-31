import { Ajv } from "ajv";
import type { Json, Schema, Skill, Workflow } from "../shared/contracts.ts";
import { validateReferences } from "../shared/bindings.ts";

const createAjv = () =>
  new Ajv({ strict: false, allErrors: true, validateSchema: true });
export function validateJson(schema: Schema, value: Json): void {
  const ajv = createAjv();
  const check = ajv.compile(schema);
  if (!check(value))
    throw Object.assign(
      new Error(ajv.errorsText(check.errors, { separator: "; " })),
      { status: 400 },
    );
}

export function validateWorkflow(workflow: Workflow, skills: Skill[]): void {
  createAjv().compile(workflow.inputSchema);
  validateReferences(workflow);
  const ids = new Set(skills.map((skill) => skill.id));
  for (const stage of workflow.stages) {
    createAjv().compile(stage.outputSchema);
    const requested = [
      ...stage.skills,
      ...stage.agents.flatMap((agent) => agent.skills),
    ];
    for (const id of requested)
      if (!ids.has(id)) throw new Error(`Unknown skill: ${id}`);
  }
}

export function validateExpansion(base: Schema, expanded: Schema): void {
  createAjv().compile(expanded);
  preserve(base, expanded);
}

function preserve(base: unknown, expanded: unknown, keyword = ""): void {
  if (Array.isArray(base)) {
    if (
      !Array.isArray(expanded) ||
      base.some(
        (item) =>
          !expanded.some(
            (other) => JSON.stringify(item) === JSON.stringify(other),
          ),
      ) ||
      (keyword !== "required" &&
        JSON.stringify(base) !== JSON.stringify(expanded))
    ) {
      throw new Error("Schema expansion removed authored constraints");
    }
  } else if (base !== null && typeof base === "object") {
    if (
      expanded === null ||
      typeof expanded !== "object" ||
      Array.isArray(expanded)
    )
      throw new Error("Schema expansion changed the base contract");
    for (const [key, value] of Object.entries(base))
      preserve(value, Reflect.get(expanded, key), key);
  } else if (base !== expanded)
    throw new Error("Schema expansion changed an authored constraint");
}
