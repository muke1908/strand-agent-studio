import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Radio, X, Pause, Play } from "lucide-react";
import { watchSchema } from "../../shared/contracts.ts";
import type {
  Json,
  Saved,
  Schema,
  Watch,
  WatchState,
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
import { SchemaForm } from "../forms/schema-form.tsx";

type Policy = {
  id: string;
  name: string;
  description: string;
  settingsSchema: Schema;
};
type WatchItem = Saved<Watch> & { state: WatchState };
export function Watches() {
  const resource = useResource<WatchItem[]>("/pipeline-watches", true);
  const workflows = useResource<Saved<Workflow>[]>("/pipelines");
  const policies = useResource<Policy[]>("/watch-policies");
  const [draft, setDraft] = useState<Watch>();
  const [revision, setRevision] = useState<string>();
  const [error, setError] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [busy, setBusy] = useState(false);
  function create() {
    setRevision(undefined);
    setError("");
    setJsonError("");
    setDraft({
      id: `watch-${crypto.randomUUID().slice(0, 8)}`,
      name: "Scheduled workflow",
      workflowId: workflows.data?.[0]?.value.id || "",
      enabled: true,
      policyId: "schedule-cron",
      settings: { expression: "0 9 * * 1-5", timeZone: "UTC" },
      inputBindings: {
        context: {
          source: "literal",
          value: "Describe the context for this recurring run.",
        },
      },
      allowAllTools: false,
      cooldownSeconds: 60,
      maxRunsPerHour: 10,
    });
  }
  async function persist(value: Watch, priorRevision?: string) {
    setBusy(true);
    try {
      await api(`/pipeline-watches/${value.id}`, {
        method: "PUT",
        body: JSON.stringify({
          value: watchSchema.parse(value),
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
  const policy = policies.data?.find((item) => item.id === draft?.policyId);
  return (
    <div className="page">
      <PageHeader
        eyebrow="LET THE PROCESS COME TO YOU"
        title="Watches"
        description="A schedule or a change. A fresh run, with the same safeguards."
      >
        <Link className="button" to="/dashboard">
          Dashboard
        </Link>
        <button className="button primary" onClick={create}>
          <Plus size={16} />
          New watch
        </button>
      </PageHeader>
      <ErrorNotice
        error={resource.error || policies.error || workflows.error || error}
      />
      {!resource.data?.length ? (
        <EmptyState
          title="Quietly watching, when you need it"
          description="Register a policy to run your workflow automatically."
        >
          <button className="button" onClick={create}>
            Create your first watch
          </button>
        </EmptyState>
      ) : (
        <div className="watch-grid">
          {resource.data.map((item) => (
            <section key={item.value.id} className="watch-card">
              <div className="watch-title">
                <Radio size={18} />
                <button
                  onClick={() => {
                    setDraft(item.value);
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
              </div>
              <p>
                {
                  policies.data?.find(
                    (entry) => entry.id === item.value.policyId,
                  )?.name
                }{" "}
                · {item.value.workflowId}
              </p>
              <StatusBadge
                status={item.value.enabled ? "watching" : "paused"}
              />
              <ErrorNotice error={item.state.error} />
              <div className="watch-meta">
                Next check:{" "}
                {new Date(item.state.nextCheck).getFullYear() === 1970
                  ? "Establishing baseline"
                  : new Date(item.state.nextCheck).toLocaleString()}
              </div>
              <div className="watch-history">
                {item.state.decisions.length ? (
                  item.state.decisions
                    .slice(-4)
                    .reverse()
                    .map((decision) => (
                      <div key={`${decision.resourceId}-${decision.eventId}`}>
                        <span>{decision.reason}</span>
                        {decision.runId ? (
                          <Link to={`/runs/${decision.runId}`}>Open run →</Link>
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
              if (!jsonError) void persist(draft, revision);
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
              Workflow
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
            <label className="field">
              Policy
              <select
                value={draft.policyId}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    policyId: event.target.value,
                    settings:
                      event.target.value === "schedule-cron"
                        ? { expression: "0 9 * * 1-5", timeZone: "UTC" }
                        : { prUrl: "" },
                  })
                }
              >
                {policies.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {policy && (
              <SchemaForm
                schema={policy.settingsSchema}
                value={draft.settings}
                onChange={(settings: Record<string, Json>) =>
                  setDraft({ ...draft, settings })
                }
              />
            )}
            <JsonEditor
              label="Workflow input bindings"
              value={draft.inputBindings}
              onChange={(value) =>
                setDraft(watchSchema.parse({ ...draft, inputBindings: value }))
              }
              onError={setJsonError}
            />
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
              <span>Queue latest. No automatic failure loop.</span>
              <button
                className="button primary"
                disabled={busy || Boolean(jsonError)}
              >
                Save watch
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
