import type { AgentBackend } from "./agent-backend.ts";
import type { Json, Schema } from "../shared/contracts.ts";

export function fixtureBackend(): AgentBackend {
  return {
    id: "test-fixture",
    diagnostics: () => ({ available: true }),
    async execute(request, signal) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(new Error("Fixture cancelled"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        }, 25);
        signal.addEventListener("abort", cancel, { once: true });
      });
      if (request.purpose === "schema")
        return JSON.parse(JSON.stringify(request.input));
      if (request.purpose === "watch-schedule") {
        const plans: Record<
          string,
          {
            description: string;
            expressions: string[];
            intervalMinutes: number | null;
          }
        > = {
          "every day at 7am": {
            description: "Every day at 07:00",
            expressions: ["0 7 * * *"],
            intervalMinutes: null,
          },
          "Every day at 7am and 7 pm": {
            description: "Every day at 07:00 and 19:00",
            expressions: ["0 7,19 * * *"],
            intervalMinutes: null,
          },
          "every 5 min": {
            description: "Every 5 minutes",
            expressions: [],
            intervalMinutes: 5,
          },
          "every 15 min": {
            description: "Every 15 minutes",
            expressions: [],
            intervalMinutes: 15,
          },
        };
        const input = request.input;
        const schedule =
          input && typeof input === "object" && !Array.isArray(input)
            ? input.schedule
            : undefined;
        const plan = typeof schedule === "string" ? plans[schedule] : undefined;
        return {
          status: plan ? "ready" : "unsupported",
          reason: plan
            ? "Fixture schedule compilation only; no natural-language interpretation."
            : "Describe a specific time or interval.",
          ...(plan ?? {
            description: "Unsupported fixture schedule",
            expressions: [],
            intervalMinutes: null,
          }),
        };
      }
      if (request.purpose === "watch-condition")
        return {
          status: "ready",
          reason:
            "Fixture condition compilation only; no natural-language interpretation.",
          conditions: [
            { pointer: "/summary", operator: "notEquals", value: "" },
          ],
          deduplicationPointer: null,
        };
      if (request.purpose === "summary")
        return {
          lines: [
            "This is a fixture-generated result summary.",
            "No real external actions were performed.",
          ],
        };
      return sample(request.schema);
    },
  };
}

function sample(schema: Schema): Json {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === "object") {
    const properties = schema.properties;
    if (!properties || typeof properties !== "object") return {};
    return Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? sample(value)
          : null,
      ]),
    );
  }
  if (schema.type === "array") return [];
  if (schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "boolean") return true;
  return "Fixture output - automated testing only";
}
