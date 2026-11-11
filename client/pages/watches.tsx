import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Radio, X, Pause, Play, Trash2 } from "lucide-react";
import {
  watchRegistrationSchema,
  watchSchema,
  jsonValue,
} from "../../shared/contracts.ts";
import type {
  Saved,
  Watch,
  WatchState,
  WatchActionRequest,
  Workflow,
} from "../../shared/contracts.ts";
import { api, errorMessage, useResource } from "../api.ts";
import {
  EmptyState,
  ErrorNotice,
  JsonEditor,
  PageHeader,
  StatusBadge,
} from "../components.tsx";
import { WatchDecisionReason, WatchTiming } from "../watch-timing.tsx";
import { readWatchSchedule } from "../../shared/watch-schedule.ts";

function defaultSettings() {
  return {
    schedule: "every day at 7am",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

type WatchItem = Saved<Watch> & { state: WatchState };
export function Watches() {
  const resource = useResource<WatchItem[]>("/pipeline-watches", true);
  const workflows = useResource<Saved<Workflow>[]>("/pipelines");
  const [draft, setDraft] = useState<Watch>();
  const [revision, setRevision] = useState<string>();
  const [error, setError] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [actionDraft, setActionDraft] = useState<WatchActionRequest>();
  const [busy, setBusy] = useState(false);
  function create() {
    setRevision(undefined);
    setError("");
    setJsonError("");
    setActionDraft(undefined);
    setDraft({
      id: `watch-${crypto.randomUUID().slice(0, 8)}`,
      name: "Scheduled workflow",
      workflowId: workflows.data?.[0]?.value.id || "",
      enabled: true,
      policyId: "schedule-cron",
      settings: defaultSettings(),
      input: "",
      inputBindings: {},
      allowAllTools: false,
      cooldownSeconds: 60,
      maxRunsPerHour: 60,
    });
  }
  async function persist(
    value: Watch,
    priorRevision?: string,
    action?: WatchActionRequest,
  ) {
    setBusy(true);
    setError("");
    try {
      await api(`/pipeline-watches/${value.id}`, {
        method: "PUT",
        body: JSON.stringify({
          value: watchRegistrationSchema.parse({
            ...value,
            ...(action ? { action } : {}),
          }),
          revision: priorRevision,
        }),
      });
      setError("");
      setDraft(undefined);
      resource.reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function deleteWatch(item: WatchItem) {
    if (
      !window.confirm(
        `Delete "${item.value.name}"? Future triggers will stop. Existing runs and results will be kept.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/pipeline-watches/${item.value.id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: item.revision }),
      });
      setDraft((current) =>
        current?.id === item.value.id ? undefined : current,
      );
      resource.reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  let schedulePreview = "";
  let scheduleError = "";
  if (
    draft &&
    (draft.settings.compiled || typeof draft.settings.expression === "string")
  ) {
    try {
      const schedule = readWatchSchedule(draft.settings);
      schedulePreview = `${schedule.description}. Next run: ${new Date(schedule.next).toLocaleString()}.`;
    } catch (failure) {
      scheduleError = errorMessage(failure);
    }
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="LET THE PROCESS COME TO YOU"
        title="Watches"
        description="Your schedule, in your words. A fresh run, with the same safeguards."
      >
        <Link className="button" to="/dashboard">
          Dashboard
        </Link>
        <button className="button primary" onClick={create}>
          <Plus size={16} />
          New watch
        </button>
      </PageHeader>
      <ErrorNotice error={resource.error || workflows.error || error} />
      {!resource.data?.length ? (
        <EmptyState
          title="Quietly watching, when you need it"
          description="Set a schedule to run your workflow automatically."
        >
          <button className="button" onClick={create}>
            Create your first watch
          </button>
        </EmptyState>
      ) : (
        <div className="watch-grid">
          {resource.data.map((item) => (
            <section
              key={item.value.id}
              className="watch-card"
              aria-label={item.value.name}
            >
              <div className="watch-title">
                <Radio size={18} />
                <button
                  onClick={() => {
                    setJsonError("");
                    setActionDraft(
                      item.value.action
                        ? {
                            workflowId: item.value.action.workflowId,
                            whenToRun: item.value.action.whenToRun ?? "",
                          }
                        : undefined,
                    );
                    setDraft({
                      ...item.value,
                      policyId: "schedule-cron",
                      settings:
                        item.value.policyId === "schedule-cron"
                          ? item.value.settings
                          : defaultSettings(),
                    });
                    setRevision(item.revision);
                  }}
                >
                  {item.value.name}
                </button>
                <button
                  className="icon-button"
                  aria-label={`${item.value.enabled ? "Pause" : "Enable"} ${item.value.name}`}
                  disabled={busy}
                  onClick={() =>
                    void persist(
                      { ...item.value, enabled: !item.value.enabled },
                      item.revision,
                    )
                  }
                >
                  {item.value.enabled ? (
                    <Pause size={15} />
                  ) : (
                    <Play size={15} />
                  )}
                </button>
                <button
                  className="icon-button danger"
                  aria-label={`Delete ${item.value.name}`}
                  title="Delete watch"
                  disabled={busy}
                  onClick={() => void deleteWatch(item)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <p>
                {item.value.workflowId}
                {item.value.action && ` → ${item.value.action.workflowId}`}
              </p>
              <StatusBadge
                status={
                  item.value.enabled
                    ? (item.state.phase ?? "watching")
                    : "paused"
                }
              />
              <ErrorNotice error={item.state.error} />
              <WatchTiming watch={item.value} state={item.state} />
              <div className="watch-history">
                {item.state.decisions.length ? (
                  item.state.decisions
                    .slice(-2)
                    .reverse()
                    .map((decision) => (
                      <div key={`${decision.resourceId}-${decision.eventId}`}>
                        <span>
                          <WatchDecisionReason
                            watch={item.value}
                            decision={decision}
                          />
                        </span>
                        {decision.runId ? (
                          <>
                            <Link to={`/runs/${decision.runId}`}>
                              {item.value.action ? "Open check" : "Open run →"}
                            </Link>
                            {decision.action?.runId && (
                              <Link to={`/runs/${decision.action.runId}`}>
                                Open action
                              </Link>
                            )}
                            {decision.outcome && (
                              <small>
                                {decision.outcomeReason ?? decision.outcome}
                              </small>
                            )}
                          </>
                        ) : (
                          <small>{decision.status}</small>
                        )}
                      </div>
                    ))
                ) : (
                  <span>
                    No triggers yet. First observation sets the baseline.
                  </span>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      {draft && (
        <div className="modal-backdrop">
          <form
            className="modal-panel"
            onSubmit={(event) => {
              event.preventDefault();
              if (!jsonError && !scheduleError)
                void persist(
                  draft,
                  revision,
                  revision ? undefined : actionDraft,
                );
            }}
          >
            <div className="inspector-heading">
              <h2>{revision ? "Edit watch" : "New watch"}</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close watch editor"
                onClick={() => setDraft(undefined)}
              >
                <X size={18} />
              </button>
            </div>
            <label className="field">
              Watch name
              <input
                required
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <label className="field">
              Action or workflow
              <select
                value={draft.workflowId}
                onChange={(event) =>
                  setDraft({ ...draft, workflowId: event.target.value })
                }
              >
                {workflows.data?.map(({ value }) => (
                  <option key={value.id} value={value.id}>
                    {value.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <label htmlFor="watch-schedule">Schedule</label>
              <input
                id="watch-schedule"
                disabled={busy}
                required={typeof draft.settings.expression !== "string"}
                maxLength={2000}
                placeholder="Every day at 7am and 7pm, or every 5 min"
                value={
                  typeof draft.settings.schedule === "string"
                    ? draft.settings.schedule
                    : ""
                }
                aria-describedby="watch-schedule-help"
                aria-invalid={Boolean(scheduleError)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    settings: {
                      schedule: event.target.value,
                      timeZone:
                        Intl.DateTimeFormat().resolvedOptions().timeZone,
                    },
                  })
                }
              />
              <small id="watch-schedule-help">
                {schedulePreview ||
                  "AI interprets your schedule once when you save."}{" "}
                Uses {String(draft.settings.timeZone ?? "UTC")}.
                {typeof draft.settings.expression === "string" &&
                  " Your existing schedule is kept unless you enter a new one."}
              </small>
              <ErrorNotice error={scheduleError} />
            </div>
            {typeof draft.input === "string" ? (
              <>
                <label className="field">
                  Input
                  <textarea
                    rows={6}
                    value={draft.input}
                    placeholder="Context or instructions for the selected action or workflow"
                    onChange={(event) =>
                      setDraft({ ...draft, input: event.target.value })
                    }
                  />
                </label>
                <p className="muted">
                  Passed unchanged to the selected action or workflow. No JSON,
                  mapping, or input-schema validation.
                </p>
              </>
            ) : Object.values(draft.inputBindings).some(
                (ref) => ref.source !== "literal",
              ) ? (
              <JsonEditor
                label="Trigger input bindings"
                value={draft.inputBindings}
                onChange={(value) =>
                  setDraft(
                    watchSchema.parse({ ...draft, inputBindings: value }),
                  )
                }
                onError={setJsonError}
              />
            ) : (
              <>
                <JsonEditor
                  label="Input"
                  value={
                    draft.input !== undefined
                      ? draft.input
                      : Object.fromEntries(
                          Object.entries(draft.inputBindings).flatMap(
                            ([name, ref]) =>
                              ref.source === "literal"
                                ? [[name, ref.value]]
                                : [],
                          ),
                        )
                  }
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      input: jsonValue.parse(value),
                      inputBindings: {},
                    })
                  }
                  onError={setJsonError}
                />
                <p className="muted">
                  JSON passed unchanged to the selected action or workflow. It
                  must match its expected input.
                </p>
              </>
            )}
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={Boolean(actionDraft)}
                disabled={Boolean(revision)}
                onChange={(event) => {
                  setActionDraft(
                    event.target.checked
                      ? {
                          workflowId:
                            workflows.data?.find(
                              ({ value }) => value.id !== draft.workflowId,
                            )?.value.id ?? draft.workflowId,
                          whenToRun: "",
                        }
                      : undefined,
                  );
                }}
              />
              Run an action workflow when the check qualifies
            </label>
            {actionDraft && (
              <>
                <label className="field">
                  Action workflow
                  <select
                    required
                    disabled={Boolean(revision)}
                    value={actionDraft.workflowId}
                    onChange={(event) =>
                      setActionDraft({
                        ...actionDraft,
                        workflowId: event.target.value,
                      })
                    }
                  >
                    {workflows.data?.map(({ value }) => (
                      <option key={value.id} value={value.id}>
                        {value.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="field">
                  <label htmlFor="watch-action-when">When to run</label>
                  <textarea
                    id="watch-action-when"
                    required={!revision}
                    readOnly={Boolean(revision)}
                    maxLength={2000}
                    rows={3}
                    placeholder="For example: Run when there are open comments and the last comment is more than 30 minutes old."
                    value={
                      actionDraft.whenToRun ||
                      (revision && draft.action
                        ? draft.action.conditions
                            .map(
                              (condition) =>
                                `${condition.pointer || "Result"} ${condition.operator} ${JSON.stringify(condition.value)}`,
                            )
                            .join(" and ")
                        : "")
                    }
                    onChange={(event) =>
                      setActionDraft({
                        ...actionDraft,
                        whenToRun: event.target.value,
                      })
                    }
                  />
                </div>
                <p className="muted">
                  {revision
                    ? "This watch uses its saved rules. Create a new watch to change the action or condition."
                    : `AI converts this sentence into fixed rules once when you save. ${typeof draft.input === "string" ? "The same text is passed to the action." : "Matching check inputs carry over to the action."} Unsupported conditions will not be saved.`}{" "}
                  Checks wait while either workflow is busy.
                </p>
              </>
            )}
            <div className="two-fields">
              <label className="field">
                Cooldown (seconds)
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={draft.cooldownSeconds}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      cooldownSeconds: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label className="field">
                Maximum runs / hour
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={draft.maxRunsPerHour}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      maxRunsPerHour: Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
            <ErrorNotice error={jsonError || error} />
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={draft.allowAllTools ?? false}
                onChange={(event) =>
                  setDraft({ ...draft, allowAllTools: event.target.checked })
                }
                aria-describedby="watch-tool-permission-help"
              />
              Allow all tools for scheduled runs
            </label>
            <p className="muted" id="watch-tool-permission-help">
              Automatically approves shell, web and MCP tools and URLs. Tools
              can change files and access external services. Enable only for
              trusted workflow instructions.
            </p>
            <div className="form-footer">
              <span>
                {actionDraft
                  ? "Suspend while busy. Fresh checks retry unsuccessful actions. Limits apply separately to each step."
                  : "Queue latest. No automatic failure loop."}
              </span>
              <button
                className="button primary"
                disabled={busy || Boolean(jsonError) || Boolean(scheduleError)}
              >
                {busy ? "Saving watch…" : "Save watch"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
