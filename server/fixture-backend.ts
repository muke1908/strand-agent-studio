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
