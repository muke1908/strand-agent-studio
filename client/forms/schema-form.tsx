import { useState } from "react";
import { jsonValue } from "../../shared/contracts.ts";
import type { Json, Schema } from "../../shared/contracts.ts";
import { schemaFields } from "../components.tsx";

export function supportsForm(schema: Schema): boolean {
  if (
    schema.type !== "object" ||
    schema.oneOf ||
    schema.anyOf ||
    schema.allOf ||
    schema.$ref
  )
    return false;
  return schemaFields(schema).every(
    ([, field]) =>
      ["string", "number", "integer", "boolean"].includes(String(field.type)) &&
      !field.oneOf &&
      !field.anyOf &&
      !field.$ref,
  );
}

export function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: Schema;
  value: Record<string, Json>;
  onChange: (value: Record<string, Json>) => void;
}) {
  return (
    <div className="schema-form">
      {schemaFields(schema).map(([key, field]) => (
        <SchemaField
          key={key}
          name={key}
          schema={field}
          value={value[key]}
          required={
            Array.isArray(schema.required) && schema.required.includes(key)
          }
          onChange={(next) => {
            const updated = { ...value };
            if (next === undefined) delete updated[key];
            else updated[key] = next;
            onChange(updated);
          }}
        />
      ))}
    </div>
  );
}

function SchemaField({
  name,
  schema,
  value,
  required,
  onChange,
}: {
  name: string;
  schema: Schema;
  value?: Json;
  required: boolean;
  onChange: (value: Json | undefined) => void;
}) {
  const label = typeof schema.title === "string" ? schema.title : name;
  const description =
    typeof schema.description === "string" ? schema.description : "";
  if (schema.type === "boolean")
    return (
      <label className="field">
        {label}
        <select
          required={required}
          value={value === undefined ? "" : String(value)}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? undefined
                : event.target.value === "true",
            )
          }
        >
          <option value="">Select a value</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
        <small>{description}</small>
      </label>
    );
  return (
    <label className="field">
      {label}
      {required && <span className="required">*</span>}
      {Array.isArray(schema.enum) ? (
        <select
          required={required}
          value={value === undefined ? "" : JSON.stringify(value)}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? undefined
                : jsonValue.parse(JSON.parse(event.target.value)),
            )
          }
        >
          <option value="">Select a value</option>
          {schema.enum.map((item) => (
            <option key={JSON.stringify(item)} value={JSON.stringify(item)}>
              {String(item)}
            </option>
          ))}
        </select>
      ) : schema.type === "number" || schema.type === "integer" ? (
        <input
          type="number"
          required={required}
          step={schema.type === "integer" ? 1 : "any"}
          value={typeof value === "number" ? value : ""}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? undefined
                : Number(event.target.value),
            )
          }
        />
      ) : (
        <textarea
          rows={description ? 6 : 3}
          required={required}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {description && <small>{description}</small>}
    </label>
  );
}

export function JsonInput({
  onChange,
}: {
  onChange: (value: Json | undefined, error: string) => void;
}) {
  const [text, setText] = useState("{}");
  return (
    <label className="field">
      JSON input
      <textarea
        rows={12}
        className="code"
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          try {
            onChange(jsonValue.parse(JSON.parse(event.target.value)), "");
          } catch (error) {
            onChange(
              undefined,
              error instanceof Error ? error.message : String(error),
            );
          }
        }}
      />
    </label>
  );
}
