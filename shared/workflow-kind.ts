import type { Workflow } from "./contracts.ts";

export function isAction(workflow: Workflow): boolean {
  return workflow.stages.length === 1 && !workflow.stages[0].loop;
}

export function workflowPath(workflow: Workflow): string {
  return `${isAction(workflow) ? "/actions" : "/pipelines"}/${workflow.id}`;
}
