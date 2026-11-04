import { isDeepStrictEqual } from "node:util";
import type { Json, Stage } from "../shared/contracts.ts";
import { pointer } from "../shared/bindings.ts";

export function loopMatches(stage: Stage, outputs: Record<string, Json>) {
  if (!stage.loop) throw new Error("Stage has no loop rule");
  const { agentId, pointer: path, operator, value } = stage.loop.condition;
  const output = outputs[`${stage.id}/${agentId}`];
  if (output === undefined)
    throw new Error(`Loop output missing: ${stage.id}/${agentId}`);
  const actual = pointer(output, path);
  const kind = (value: Json) =>
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (kind(actual) !== kind(value))
    throw new Error(
      `Loop condition ${stage.name}${path} has type ${kind(actual)}; expected ${kind(value)}`,
    );
  if (operator === "equals")
    return { matches: isDeepStrictEqual(actual, value), value: actual };
  if (operator === "notEquals")
    return { matches: !isDeepStrictEqual(actual, value), value: actual };
  if (typeof actual !== "number" || typeof value !== "number")
    throw new Error(
      `Loop condition ${stage.name}${path} requires numeric values`,
    );
  const matches =
    operator === "greaterThan"
      ? actual > value
      : operator === "greaterThanOrEqual"
        ? actual >= value
        : operator === "lessThan"
          ? actual < value
          : actual <= value;
  return { matches, value: actual };
}
