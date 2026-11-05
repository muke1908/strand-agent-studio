import { isDeepStrictEqual } from "node:util";
import type { Json } from "../shared/contracts.ts";

export function compareValues(
  actual: Json,
  operator:
    | "equals"
    | "notEquals"
    | "greaterThan"
    | "greaterThanOrEqual"
    | "lessThan"
    | "lessThanOrEqual",
  value: Json,
  label: string,
): boolean {
  const kind = (item: Json) =>
    item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
  if (kind(actual) !== kind(value))
    throw new Error(
      `${label} has type ${kind(actual)}; expected ${kind(value)}`,
    );
  if (operator === "equals") return isDeepStrictEqual(actual, value);
  if (operator === "notEquals") return !isDeepStrictEqual(actual, value);
  if (typeof actual !== "number" || typeof value !== "number")
    throw new Error(`${label} requires numeric values`);
  return operator === "greaterThan"
    ? actual > value
    : operator === "greaterThanOrEqual"
      ? actual >= value
      : operator === "lessThan"
        ? actual < value
        : actual <= value;
}
