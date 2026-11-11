import type { Stage } from "../../shared/contracts.ts";

type Loop = NonNullable<Stage["loop"]>;
export const loopComparisonLabels: Record<
  Loop["condition"]["operator"],
  string
> = {
  equals: "is",
  notEquals: "is not",
  greaterThan: "is greater than",
  greaterThanOrEqual: "is at least",
  lessThan: "is less than",
  lessThanOrEqual: "is at most",
};

export function describeLoopCondition(loop: Loop): string {
  if (loop.repeatWhen !== undefined) return loop.repeatWhen;
  const { pointer, operator, value } = loop.condition;
  const field = pointer ? pointer.slice(1) : "Entire output";
  return `${field} ${loopComparisonLabels[operator]} ${JSON.stringify(value)}`;
}
