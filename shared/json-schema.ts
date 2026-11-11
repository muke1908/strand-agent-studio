import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import type { Json, Schema } from "./contracts.ts";

function formatsPlugin(plugin: FormatsPlugin | { default: FormatsPlugin }) {
  return typeof plugin === "function" ? plugin : plugin.default;
}

export function createJsonValidator(schema: Schema) {
  const Validator =
    schema.$schema === "https://json-schema.org/draft/2020-12/schema"
      ? Ajv2020
      : Ajv;
  const ajv = new Validator({
    strict: false,
    allErrors: true,
    validateSchema: true,
    $data: true,
  });
  formatsPlugin(addFormats)(ajv, { keywords: true });
  return ajv;
}

export function validateJson(schema: Schema, value: Json): void {
  const ajv = createJsonValidator(schema);
  const check = ajv.compile(schema);
  if (!check(value))
    throw Object.assign(
      new Error(ajv.errorsText(check.errors, { separator: "; " })),
      { status: 400 },
    );
}
