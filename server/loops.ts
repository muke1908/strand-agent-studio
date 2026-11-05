import type { Json, Stage } from "../shared/contracts.ts";
import { pointer } from "../shared/bindings.ts";
import { compareValues } from "./conditions.ts";

export function loopMatches(stage: Stage, outputs: Record<string, Json>) {
  if (!stage.loop) throw new Error("Stage has no loop rule");
  const { agentId, pointer: path, operator, value } = stage.loop.condition;
  const output = outputs[`${stage.id}/${agentId}`];
  if (output === undefined)
    throw new Error(`Loop output missing: ${stage.id}/${agentId}`);
  const actual = pointer(output, path);
  return {
    matches: compareValues(
      actual,
      operator,
      value,
      `Loop condition ${stage.name}${path}`,
    ),
    value: actual,
  };
}
