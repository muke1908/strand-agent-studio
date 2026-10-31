import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workflowSchema } from "../shared/contracts.ts";
import type { Workflow, Run } from "../shared/contracts.ts";

export function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "strand-test-"));
}
export function workflow(id = "sample"): Workflow {
  return workflowSchema.parse({
    id,
    name: "Sample workflow",
    inputSchema: {
      type: "object",
      required: ["context"],
      properties: { context: { type: "string" } },
    },
    stages: [
      {
        id: "discover",
        name: "Discover",
        inputs: { context: { source: "input", pointer: "/context" } },
        outputSchema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
          additionalProperties: false,
        },
        agents: [
          { id: "alpha", name: "Alpha" },
          { id: "beta", name: "Beta" },
        ],
      },
      {
        id: "report",
        name: "Report",
        inputs: {
          evidence: {
            source: "stage",
            stageId: "discover",
            agentId: "alpha",
            pointer: "/summary",
          },
        },
        outputSchema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
        },
        agents: [{ id: "writer", name: "Writer" }],
      },
    ],
  });
}
export async function waitForRun(read: () => Run): Promise<Run> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = read();
    if (!["queued", "running"].includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not settle");
}
