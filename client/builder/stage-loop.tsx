import { useEffect, useRef, useState } from "react";
import { ArrowRight, Repeat2 } from "lucide-react";
import {
  jsonValue,
  loopOperators,
  stageSchema,
} from "../../shared/contracts.ts";
import type { Json, Stage, Workflow } from "../../shared/contracts.ts";
import { JsonEditor, schemaFields } from "../components.tsx";
import { describeLoopCondition, loopComparisonLabels } from "./loop-labels.ts";

export function StageLoop({
  stage,
  workflow,
  update,
  error,
}: {
  stage: Stage;
  workflow: Workflow;
  update: (stage: Stage) => void;
  error: (key: string, message: string) => void;
}) {
  const loop = stage.loop;
  const index = workflow.stages.findIndex((item) => item.id === stage.id);
  const fields = schemaFields(stage.outputSchema).map(([name, schema]) => ({
    name,
    pointer: `/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`,
    type: schema.type,
  }));
  const [customField, setCustomField] = useState(false);
  const [jsonMode, setJsonMode] = useState(false);
  const targetIndex = workflow.stages.findIndex(
    (item) => item.id === loop?.targetStageId,
  );
  const repeated = workflow.stages.slice(Math.max(0, targetIndex), index + 1);
  const next = workflow.stages[index + 1];
  const valueError = (message: string) =>
    error(`loop-value-${stage.id}`, message);
  function changeValue(value: Json) {
    if (loop)
      update({
        ...stage,
        loop: {
          ...loop,
          condition: {
            ...loop.condition,
            value,
            operator:
              typeof value === "number" ||
              ["equals", "notEquals"].includes(loop.condition.operator)
                ? loop.condition.operator
                : "equals",
          },
        },
      });
  }
  const valueType =
    loop &&
    !jsonMode &&
    loop.condition.value !== null &&
    typeof loop.condition.value !== "object"
      ? typeof loop.condition.value
      : "json";
  return (
    <fieldset className="stage-loop">
      <legend>
        <Repeat2 size={14} /> Repeat &amp; continue
      </legend>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={Boolean(loop)}
          onChange={(event) => {
            error(`loop-value-${stage.id}`, "");
            error(`loop-feedback-${stage.id}`, "");
            setCustomField(false);
            setJsonMode(false);
            update({
              ...stage,
              loop: event.target.checked
                ? {
                    targetStageId: workflow.stages[Math.max(0, index - 1)].id,
                    condition: {
                      agentId: stage.agents[0].id,
                      pointer: "/needsAnotherPass",
                      operator: "equals",
                      value: true,
                    },
                    maxIterations: 3,
                    feedback: {
                      result: {
                        source: "stage",
                        stageId: stage.id,
                        agentId: stage.agents[0].id,
                        pointer: "",
                      },
                    },
                  }
                : undefined,
            });
          }}
        />
        Repeat earlier stages when a condition matches
      </label>
      {!loop ? (
        <p className="muted">
          Off: continue to {next?.name ?? "the workflow result"} after this
          stage.
        </p>
      ) : (
        <>
          <div className="loop-preview" role="region" aria-label="Loop preview">
            <div className="loop-outcome repeat">
              <Repeat2 size={15} />
              <div>
                <strong>If {describeLoopCondition(loop)}</strong>
                <span>Go back to {repeated[0]?.name} and run:</span>
                <ol className="loop-range">
                  {repeated.map((item, step) => (
                    <li key={item.id}>
                      {step > 0 && <ArrowRight size={12} aria-hidden="true" />}
                      <span>{item.name}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
            <div className="loop-outcome continue">
              <ArrowRight size={15} />
              <div>
                <strong>Otherwise</strong>
                <span>
                  {next ? `Continue to ${next.name}` : "Finish the workflow"}
                </span>
              </div>
            </div>
            <p>
              Still matches on pass {loop.maxIterations}? Stop and mark the run
              blocked.
            </p>
          </div>
          <h3 className="loop-section-title">1. When should it repeat?</h3>
          <label className="field">
            Read output from
            <select
              value={loop.condition.agentId}
              onChange={(event) => {
                valueError("");
                update({
                  ...stage,
                  loop: {
                    ...loop,
                    condition: {
                      ...loop.condition,
                      agentId: event.target.value,
                    },
                  },
                });
              }}
            >
              {stage.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Output field
            <select
              value={
                !customField &&
                fields.some((field) => field.pointer === loop.condition.pointer)
                  ? loop.condition.pointer
                  : "custom"
              }
              onChange={(event) => {
                if (event.target.value === "custom") {
                  setCustomField(true);
                  return;
                }
                setCustomField(false);
                const field = fields.find(
                  (item) => item.pointer === event.target.value,
                );
                const numeric =
                  field?.type === "number" || field?.type === "integer";
                const value =
                  numeric && typeof loop.condition.value !== "number"
                    ? 0
                    : field?.type === "boolean" &&
                        typeof loop.condition.value !== "boolean"
                      ? true
                      : field?.type === "string" &&
                          typeof loop.condition.value !== "string"
                        ? ""
                        : loop.condition.value;
                valueError("");
                setJsonMode(false);
                update({
                  ...stage,
                  loop: {
                    ...loop,
                    condition: {
                      ...loop.condition,
                      pointer: event.target.value,
                      value,
                      operator:
                        numeric ||
                        ["equals", "notEquals"].includes(
                          loop.condition.operator,
                        )
                          ? loop.condition.operator
                          : "equals",
                    },
                  },
                });
              }}
            >
              {fields.map((field) => (
                <option key={field.pointer} value={field.pointer}>
                  {field.name}
                </option>
              ))}
              <option value="custom">Custom field path...</option>
            </select>
          </label>
          {(customField ||
            !fields.some(
              (field) => field.pointer === loop.condition.pointer,
            )) && (
            <label className="field">
              Custom field path
              <input
                aria-label="Custom field path"
                placeholder="/result/needsAnotherPass"
                value={loop.condition.pointer}
                onChange={(event) => {
                  valueError("");
                  update({
                    ...stage,
                    loop: {
                      ...loop,
                      condition: {
                        ...loop.condition,
                        pointer: event.target.value,
                      },
                    },
                  });
                }}
              />
              <small>
                Use /field or /nested/field. Leave empty to compare the entire
                output.
              </small>
            </label>
          )}
          <label className="field">
            Comparison
            <select
              value={loop.condition.operator}
              onChange={(event) => {
                const operator = loopOperators.find(
                  (value) => value === event.target.value,
                );
                if (operator) {
                  const numeric =
                    operator !== "equals" && operator !== "notEquals";
                  valueError("");
                  if (numeric) {
                    setJsonMode(false);
                  }
                  update({
                    ...stage,
                    loop: {
                      ...loop,
                      condition: {
                        ...loop.condition,
                        operator,
                        value:
                          numeric && typeof loop.condition.value !== "number"
                            ? 0
                            : loop.condition.value,
                      },
                    },
                  });
                }
              }}
            >
              {loopOperators.map((operator) => (
                <option key={operator} value={operator}>
                  {loopComparisonLabels[operator]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Value type
            <select
              value={valueType}
              onChange={(event) => {
                const type = event.target.value;
                setJsonMode(type === "json");
                valueError("");
                if (type !== "json")
                  changeValue(
                    type === "boolean" ? true : type === "number" ? 0 : "",
                  );
              }}
            >
              <option value="boolean">True / false</option>
              <option value="number">Number</option>
              <option value="string">Text</option>
              <option value="json">JSON (advanced)</option>
            </select>
          </label>
          {valueType === "boolean" ? (
            <label className="field">
              Comparison value
              <select
                value={String(loop.condition.value)}
                onChange={(event) => changeValue(event.target.value === "true")}
              >
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            </label>
          ) : valueType === "number" || valueType === "string" ? (
            <SimpleValue
              key={`${valueType}-${loop.condition.agentId}-${loop.condition.pointer}-${loop.condition.operator}`}
              value={loop.condition.value}
              numeric={valueType === "number"}
              onChange={changeValue}
              onError={valueError}
            />
          ) : (
            <JsonEditor
              key={`${loop.condition.agentId}-${loop.condition.pointer}-${loop.condition.operator}`}
              label="Comparison value"
              value={loop.condition.value}
              onChange={(value) => changeValue(jsonValue.parse(value))}
              onError={valueError}
            />
          )}
          <h3 className="loop-section-title">2. Where should it go back?</h3>
          <label className="field">
            Repeat from stage
            <select
              aria-label="Repeat from stage"
              value={loop.targetStageId}
              onChange={(event) =>
                update({
                  ...stage,
                  loop: { ...loop, targetStageId: event.target.value },
                })
              }
            >
              {workflow.stages.slice(0, index + 1).map((item, step) => (
                <option key={item.id} value={item.id}>
                  {step + 1}. {item.name}
                  {item.id === stage.id ? " (this stage only)" : ""}
                </option>
              ))}
            </select>
            <small>
              Every stage from here through {stage.name} runs again. Keep
              one-time setup and publication outside this range.
            </small>
          </label>
          <h3 className="loop-section-title">3. When should it stop trying?</h3>
          <label className="field">
            Maximum total passes
            <input
              aria-label="Maximum total passes"
              type="number"
              min={1}
              max={20}
              value={loop.maxIterations}
              onChange={(event) =>
                update({
                  ...stage,
                  loop: { ...loop, maxIterations: Number(event.target.value) },
                })
              }
            />
            <small>
              Includes the first pass. {loop.maxIterations} total passes allow
              up to {Math.max(0, loop.maxIterations - 1)} repeat
              {loop.maxIterations === 2 ? "" : "s"}. Limit: 1–20.
            </small>
          </label>
          <div className="loop-feedback-summary">
            <strong>Feedback sent on repeat</strong>
            <span>
              {Object.keys(loop.feedback).join(", ") ||
                "No feedback configured"}
            </span>
          </div>
          <details className="loop-advanced">
            <summary>Feedback &amp; advanced settings</summary>
            <p className="muted">
              Choose which accepted outputs are passed back. Existing mappings
              are kept unless you edit them.
            </p>
            <JsonEditor
              label="Loop feedback bindings"
              value={loop.feedback}
              onChange={(value) =>
                update(
                  stageSchema.parse({
                    ...stage,
                    loop: { ...loop, feedback: value },
                  }),
                )
              }
              onError={(message) => error(`loop-feedback-${stage.id}`, message)}
            />
            <p className="muted">
              Agents receive feedback automatically; the first pass has none.
              Input bindings can also use{" "}
              {`{"source":"loop","pointer":"/feedback"}`}, with an optional
              first-pass default.
            </p>
            <p className="muted">
              Missing output or status &quot;blocked&quot; stops execution, not
              another pass. Skipping this stage bypasses its loop. Loop ranges
              cannot overlap or nest.
            </p>
          </details>
        </>
      )}
    </fieldset>
  );
}

function SimpleValue({
  value,
  numeric,
  onChange,
  onError,
}: {
  value: Json;
  numeric: boolean;
  onChange: (value: Json) => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState(String(value));
  const committed = useRef(value);
  useEffect(() => {
    if (value !== committed.current) {
      setText(String(value));
      committed.current = value;
    }
  }, [value]);
  return (
    <label className="field">
      Comparison value
      <input
        value={text}
        inputMode={numeric ? "decimal" : "text"}
        onChange={(event) => {
          const text = event.target.value;
          setText(text);
          if (numeric && (!text.trim() || !Number.isFinite(Number(text)))) {
            onError("Enter a valid number for the loop comparison.");
            return;
          }
          const next = numeric ? Number(text) : text;
          onChange(next);
          committed.current = next;
          onError("");
        }}
      />
    </label>
  );
}
