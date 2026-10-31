import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, RotateCcw, Square, ExternalLink } from "lucide-react";
import type { Run } from "../../shared/contracts.ts";
import { api, errorMessage, useResource } from "../api.ts";
import { RunUnitDetails } from "../run-unit-details.tsx";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
} from "../components.tsx";

export function Runs() {
  const { data, error } = useResource<Run[]>("/pipeline-runs", true);
  return (
    <div className="page">
      <PageHeader
        eyebrow="EXECUTION HISTORY"
        title="Runs"
        description="Every attempt, every handoff, every result. Nothing hidden."
      />
      <ErrorNotice error={error} />
      {!data ? (
        <Loading />
      ) : !data.length ? (
        <EmptyState
          title="No runs yet"
          description="Open a workflow and give it some context."
        >
          <Link className="button" to="/pipelines">
            Explore workflows
          </Link>
        </EmptyState>
      ) : (
        <div className="list-panel">
          {data.map((run) => (
            <Link key={run.id} className="list-row" to={`/runs/${run.id}`}>
              <div>
                <strong>{run.workflowName}</strong>
                <span>
                  {run.trigger ? run.trigger.reason : "Manual run"} ·{" "}
                  {new Date(run.createdAt).toLocaleString()}
                </span>
              </div>
              <StatusBadge status={run.status} />
              <ExternalLink size={14} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
export function RunDetail() {
  const { id } = useParams();
  const resource = useResource<Run>(`/pipeline-runs/${id}`, true);
  const logs = useResource<{ content: string }>(
    `/pipeline-runs/${id}/logs`,
    true,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState<string>();
  async function act(action: "stop" | "resume") {
    setBusy(true);
    try {
      await api(`/pipeline-runs/${id}/${action}`, { method: "POST" });
      setError("");
      resource.reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const run = resource.data;
  if (!run)
    return (
      <div className="page">
        <ErrorNotice error={resource.error} />
        <Loading />
      </div>
    );
  return (
    <div className="page">
      <Link className="back-link" to="/runs">
        <ArrowLeft size={14} />
        All runs
      </Link>
      <PageHeader
        eyebrow="RUN DETAILS"
        title={run.workflowName}
        description={`${run.id} · ${run.trigger ? run.trigger.reason : "Manual run"} · ${run.allowAllTools ? "All tools allowed" : "Restricted tools"}`}
      >
        <StatusBadge status={run.status} />
        {["queued", "running"].includes(run.status) ? (
          <button
            className="button"
            disabled={busy}
            onClick={() => void act("stop")}
          >
            <Square size={14} />
            Stop
          </button>
        ) : (
          run.status !== "completed" && (
            <button
              className="button"
              disabled={busy}
              onClick={() => void act("resume")}
            >
              <RotateCcw size={14} />
              Resume
            </button>
          )
        )}
      </PageHeader>
      {Boolean(run.allowedFolders?.length) && (
        <p className="muted">
          Legacy run folders: {run.allowedFolders?.join(", ")}
        </p>
      )}
      <ErrorNotice error={error || resource.error || run.error || logs.error} />
      <div className="run-layout">
        <section>
          <div className="section-heading">
            <h2>Agent activity</h2>
          </div>
          <div className="list-panel">
            {Object.entries(run.units).map(([key, unit]) => (
              <button
                key={key}
                type="button"
                className="list-row activity-card"
                aria-label={`View ${unit.name} input and output`}
                onClick={() => setSelectedUnit(key)}
              >
                <div>
                  <strong>{unit.name}</strong>
                  <span>
                    {unit.stageId} · {unit.attempts.length} attempt
                    {unit.attempts.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <StatusBadge status={unit.status} />
              </button>
            ))}
            {!Object.keys(run.units).length && (
              <div className="quiet-empty">
                Preparing pinned output contracts…
              </div>
            )}
          </div>
        </section>
        <section>
          <div className="section-heading">
            <h2>Result</h2>
          </div>
          <pre className="result-panel">
            {run.result === undefined
              ? "The result will appear when the workflow completes."
              : JSON.stringify(run.result, null, 2)}
          </pre>
        </section>
      </div>
      <details className="logs">
        <summary>Execution logs</summary>
        <pre>{logs.data?.content || "No process logs yet."}</pre>
      </details>
      {selectedUnit && run.units[selectedUnit] && (
        <RunUnitDetails
          key={`${run.id}/${selectedUnit}`}
          runId={run.id}
          unitKey={selectedUnit}
          name={run.units[selectedUnit].name}
          onClose={() => setSelectedUnit(undefined)}
        />
      )}
    </div>
  );
}
