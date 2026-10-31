import type { Catalog } from "./catalog.ts";
import { workflowSchema } from "../shared/contracts.ts";

export function seedCatalog(catalog: Catalog): void {
  const skills = [
    {
      id: "evidence-first",
      name: "Evidence first",
      description:
        "Separate observations, assumptions, and unresolved questions.",
      instructions:
        "Ground every claim in the supplied material. Distinguish evidence from inference. Report missing evidence explicitly. Never invent retrieved data or claim tool operations you did not perform.",
    },
    {
      id: "clear-writing",
      name: "Clear writing",
      description: "Produce concise, structured, actionable reports.",
      instructions:
        "Write a short actionable summary. Prefer precise language, readable structure, and concrete next steps. Do not overstate confidence.",
    },
    {
      id: "senior-engineer",
      name: "Senior engineer",
      description:
        "Readability, conventions, correctness, and meaningful tradeoffs.",
      instructions:
        "Follow existing conventions. Prioritize readability, scalability, performance, and security. Avoid overengineering. Trace a concern to evidence before recommending changes.",
    },
  ];
  const existing = new Set(catalog.skills().map((item) => item.value.id));
  for (const skill of skills)
    if (!existing.has(skill.id)) catalog.saveSkill(skill);
  if (catalog.workflows().length || catalog.hasWorkflowHistory()) return;
  const reportSchema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "evidence", "nextSteps"],
    properties: {
      summary: { type: "string" },
      evidence: { type: "array", items: { type: "string" } },
      nextSteps: { type: "array", items: { type: "string" } },
    },
  };
  for (const [id, name, description, stageNames] of [
    [
      "bug-triage",
      "Bug triage",
      "Turn a bug report into an evidence-backed investigation plan.",
      ["Understand", "Investigate", "Triage"],
    ],
    [
      "change-review",
      "Change review",
      "Independent review and reconciliation of supplied changes.",
      ["Review", "Challenge", "Reconcile"],
    ],
    [
      "document-audit",
      "Document audit",
      "Find gaps and contradictions in supplied documentation.",
      ["Analyze", "Report"],
    ],
  ] as const) {
    catalog.saveWorkflow(
      workflowSchema.parse({
        id,
        name,
        description,
        inputSchema: {
          type: "object",
          required: ["context"],
          additionalProperties: false,
          properties: {
            context: {
              type: "string",
              minLength: 1,
              title: "Context",
              description:
                "Paste the report, diff, or documentation to analyze.",
            },
          },
        },
        stages: stageNames.map((stageName, index) => ({
          id: stageName.toLowerCase(),
          name: stageName,
          instructions: `${stageName} the supplied material for ${name}. Use complete prior handoffs. No external retrieval or publication is authorized.`,
          skills: ["evidence-first"],
          inputs: { context: { source: "input", pointer: "/context" } },
          outputSchema: reportSchema,
          agents: [
            {
              id: "analyst",
              name: index === 0 ? "Analyst" : "Reviewer",
              skills: [
                index === stageNames.length - 1
                  ? "clear-writing"
                  : "senior-engineer",
              ],
            },
          ],
        })),
      }),
    );
  }
}
