import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  RotateCcw,
  Square,
  ExternalLink,
  Download,
  SkipForward,
} from "lucide-react";
import type { Run, RunDetails, Unit } from "../../shared/contracts.ts";
import { api, errorMessage, useResource } from "../api.ts";
import { RunUnitDetails } from "../run-unit-details.tsx";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
} from "../components.tsx";

function stageExecution(
  run: RunDetails,
  stage: RunDetails["stages"][number],
): Unit["status"] {
  const contract = run.units[`@schema/${stage.id}`];
  const agents = stage.agents.map(({ id }) => run.units[`${stage.id}/${id}`]);
  const units = [contract, ...agents];
  if (units.every((unit) => unit?.status === "skipped")) return "skipped";
  if (
    run.status === "running" &&
    units.some((unit) => unit?.status === "running")
  )
    return "running";
  if (units.some((unit) => unit?.status === "blocked")) return "blocked";
  if (units.some((unit) => unit?.status === "cancelled")) return "cancelled";
  if (
    contract?.status === "completed" &&
    agents.every((unit) => unit?.status === "completed")
  )
    return "completed";
  if (run.currentStage === stage.id && run.status !== "completed")
    return run.status;
  return "queued";
}

function reportedOutcome(unit?: Unit): string | undefined {
  if (unit?.status !== "completed" && unit?.status !== "skipped")
    return undefined;
  const output = unit.output;
  return output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    typeof output.status === "string" &&
    output.status.trim()
    ? output.status
    : undefined;
}

export function Runs() {
  const { data, error } = useResource<Run[]>("/pipeline-runs", true);
  const groups = new Map<string, { name: string; runs: Run[] }>();
  for (const run of data ?? []) {
    let group = groups.get(run.workflowId);
    if (!group) {
      group = { name: run.workflowName, runs: [] };
      groups.set(run.workflowId, group);
    }
    if (group.runs.length < 10) group.runs.push(run);
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="EXECUTION HISTORY"
        title="Runs"
        description="The 10 most recent runs for each workflow."
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
        <section className="run-history" aria-label="Recent runs">
          {Array.from(groups, ([workflowId, group]) => (
            <section key={workflowId} aria-labelledby={`runs-${workflowId}`}>
              <div className="section-heading">
                <h2 id={`runs-${workflowId}`}>{group.name}</h2>
                <span className="eyebrow">
                  {group.runs.length} {group.runs.length === 1 ? "run" : "runs"}
                </span>
              </div>
              <div className="list-panel">
                {group.runs.map((run) => (
                  <Link
                    key={run.id}
                    className="list-row"
                    to={`/runs/${run.id}`}
                  >
                    <div>
                      <strong>
                        {run.trigger ? run.trigger.reason : "Manual run"}
                      </strong>
                      <span>{new Date(run.createdAt).toLocaleString()}</span>
                    </div>
                    <StatusBadge status={run.status} />
                    <ExternalLink size={14} />
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </section>
      )}
    </div>
  );
}
export function RunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const resource = useResource<RunDetails>(`/pipeline-runs/${id}`, true);
  const logs = useResource<{ content: string }>(
    `/pipeline-runs/${id}/logs`,
    true,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState<string>();
  const [rerunRequest, setRerunRequest] = useState<{
    sourceRunId: string;
    stageId: string;
    requestId: string;
    latestInstructions: boolean;
  }>();
  const [skipStage, setSkipStage] = useState<RunDetails["stages"][number]>();
  const skipDialog = useRef<HTMLDialogElement>(null);
  const [skipReason, setSkipReason] = useState("");
  const [allowPublication, setAllowPublication] = useState(false);
  const [skipRequest, setSkipRequest] = useState<{
    sourceRunId: string;
    stageId: string;
    reason: string;
    allowPublication: boolean;
    requestId: string;
  }>();
  useEffect(() => {
    if (!skipStage) return;
    const element = skipDialog.current;
    element?.showModal();
    return () => element?.close();
  }, [skipStage]);
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
  const selectedRecord = selectedUnit?.includes(":")
    ? run?.visits?.find((visit) => visit.id === selectedUnit.split(":")[0])
        ?.units[selectedUnit.slice(selectedUnit.indexOf(":") + 1)]
    : selectedUnit
      ? run?.units[selectedUnit]
      : undefined;
  async function skip() {
    if (!run || !skipStage) return;
    const reason = skipReason.trim();
    if (!reason) {
      setError("Enter a reason for skipping this stage.");
      return;
    }
    const submission =
      skipRequest?.sourceRunId === run.id &&
      skipRequest.stageId === skipStage.id &&
      skipRequest.reason === reason &&
      skipRequest.allowPublication === allowPublication
        ? skipRequest
        : {
            sourceRunId: run.id,
            stageId: skipStage.id,
            reason,
            allowPublication,
            requestId: crypto.randomUUID(),
          };
    setSkipRequest(submission);
    setBusy(true);
    try {
      const next = await api<Run>(`/pipeline-runs/${run.id}/skip`, {
        method: "POST",
        body: JSON.stringify({
          stageId: submission.stageId,
          requestId: submission.requestId,
          reason: submission.reason,
          allowPublication: submission.allowPublication,
        }),
      });
      setError("");
      setSkipStage(undefined);
      setSelectedUnit(undefined);
      navigate(`/runs/${next.id}`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function downloadAssets() {
    if (!run) return;
    setDownloading(true);
    setError("");
    try {
      const response = await fetch(`/api/pipeline-runs/${run.id}/assets`);
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || `Download failed (${response.status})`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${run.id}-assets.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setDownloading(false);
    }
  }
  async function generateSummary() {
    if (!run) return;
    setSummaryBusy(true);
    setSummaryError("");
    try {
      await api(`/pipeline-runs/${run.id}/result-summary`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      resource.reload();
    } catch (failure) {
      setSummaryError(errorMessage(failure));
    } finally {
      setSummaryBusy(false);
    }
  }
  async function rerun(
    stage: RunDetails["stages"][number],
    index: number,
    latestInstructions = false,
  ) {
    if (
      !run ||
      !window.confirm(
        `${latestInstructions ? "Restart" : "Rerun"} from "${stage.name}"?\n\n${index ? "Earlier handoffs will be reused; earlier agents will not run." : "All stages will run again, including configured setup actions."}\n${latestInstructions ? "Latest compatible instructions will be loaded. Interrupted attempts can be recovered only after their processes are confirmed stopped.\n" : ""}This stage and every later stage will execute in a new run and may modify the existing workspace or external resources. The original run will remain unchanged.`,
      )
    )
      return;
    const submission =
      rerunRequest?.sourceRunId === run.id &&
      rerunRequest.stageId === stage.id &&
      rerunRequest.latestInstructions === latestInstructions
        ? rerunRequest
        : {
            sourceRunId: run.id,
            stageId: stage.id,
            requestId: crypto.randomUUID(),
            latestInstructions,
          };
    setRerunRequest(submission);
    setBusy(true);
    try {
      const next = await api<Run>(`/pipeline-runs/${run.id}/rerun`, {
        method: "POST",
        body: JSON.stringify({
          stageId: stage.id,
          requestId: submission.requestId,
          ...(latestInstructions ? { latestInstructions: true } : {}),
        }),
      });
      setError("");
      setSelectedUnit(undefined);
      navigate(`/runs/${next.id}`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
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
        {run.status === "completed" && (
          <button
            type="button"
            className="button"
            disabled={downloading}
            title="Download reports, results, agent outputs, and execution logs as a ZIP"
            onClick={() => void downloadAssets()}
          >
            <Download size={14} />
            {downloading ? "Downloading..." : "Download assets"}
          </button>
        )}
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
      {run.continuation && (
        <p className="muted">
          Continuing from{" "}
          <Link to={`/runs/${run.continuation.sourceRunId}`}>
            an earlier run
          </Link>
          ; previous handoffs are reused.
        </p>
      )}
      {Boolean(run.allowedFolders?.length) && (
        <p className="muted">
          Legacy run folders: {run.allowedFolders?.join(", ")}
        </p>
      )}
      {run.stageSkips?.map((override) => (
        <p className="skip-notice" key={override.stageId}>
          <strong>
            {run.stages.find((stage) => stage.id === override.stageId)?.name ??
              override.stageId}{" "}
            skipped by owner
          </strong>
          {" — "}
          {override.reason}. Not a pass.{" "}
          {override.allowPublication
            ? "Publication permitted only if remaining review and safety gates approve."
            : "Publication not authorized; review/report only."}
        </p>
      ))}
      <ErrorNotice error={error || resource.error || run.error || logs.error} />
      {["blocked", "cancelled"].includes(run.status) && (
        <p className="muted">
          Restart a stage below to create a fresh attempt with the latest
          compatible instructions. Earlier stages are reused, not repeated.
          Resume keeps the original instructions and accepted outputs.
        </p>
      )}
      {skipStage && (
        <dialog
          ref={skipDialog}
          className="modal-panel skip-dialog"
          aria-labelledby="skip-stage-title"
          onCancel={(event) => {
            if (busy) event.preventDefault();
          }}
          onClose={(event) => {
            if (!event.currentTarget.open) setSkipStage(undefined);
          }}
        >
          <form
            className="skip-stage-form"
            aria-label={`Skip ${skipStage.name} stage`}
            onSubmit={(event) => {
              event.preventDefault();
              void skip();
            }}
          >
            <div className="inspector-heading">
              <h2 id="skip-stage-title">Skip {skipStage.name}?</h2>
            </div>
            <p>
              This creates a new continuation. Earlier handoffs are reused; this
              stage will not execute or be marked passed. Later stages may
              change the existing workspace or external resources. Missing
              output fields may still block dependent stages. The original run
              stays unchanged.
            </p>
            <ErrorNotice error={error} />
            <label>
              Reason for skipping
              <textarea
                required
                maxLength={2000}
                value={skipReason}
                disabled={busy}
                onChange={(event) => setSkipReason(event.target.value)}
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={allowPublication}
                disabled={busy}
                onChange={(event) => setAllowPublication(event.target.checked)}
              />
              Allow downstream commit/push/PR publication despite this skip,
              only if remaining review and safety gates approve
            </label>
            <div className="stage-actions">
              <button
                type="submit"
                className="button primary"
                disabled={busy || !skipReason.trim()}
              >
                Skip stage and continue
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => skipDialog.current?.close()}
              >
                Cancel
              </button>
            </div>
          </form>
        </dialog>
      )}
      <div className="run-layout">
        <section>
          <div className="section-heading">
            <h2>Stages</h2>
          </div>
          <p className="stage-legend">
            Green: executed · Circulating border: executing · Grey: not executed
            · Amber: skipped
          </p>
          <div className="stage-list">
            {run.stages.map((stage, index) => {
              const execution = stageExecution(run, stage);
              const contract = run.units[`@schema/${stage.id}`];
              const prefixReady = run.stages.slice(0, index).every(
                (previous) =>
                  ["completed", "skipped"].includes(
                    run.units[`@schema/${previous.id}`]?.status ?? "",
                  ) &&
                  previous.agents.every((agent) => {
                    const unit = run.units[`${previous.id}/${agent.id}`];
                    return (
                      (unit?.status === "completed" ||
                        unit?.status === "skipped") &&
                      reportedOutcome(unit) !== "blocked"
                    );
                  }),
              );
              const inactive = !["queued", "running"].includes(run.status);
              const executionLabel = {
                completed: "Executed",
                running: "Executing",
                queued: "Not executed",
                blocked: "Execution blocked",
                cancelled: "Execution cancelled",
                skipped: "Skipped by owner — not passed",
              }[execution];
              return (
                <section
                  key={stage.id}
                  className={`run-stage stage-${execution}`}
                  aria-label={`${stage.name} stage`}
                  aria-description={executionLabel}
                  aria-busy={execution === "running"}
                >
                  <div className="stage-content">
                    <div className="stage-heading">
                      <div>
                        <h3>
                          {index + 1}. {stage.name}
                        </h3>
                        {execution !== "completed" && (
                          <span className="stage-execution">
                            {executionLabel}
                          </span>
                        )}
                      </div>
                      <div className="stage-actions">
                        {["blocked", "cancelled"].includes(run.status) && (
                          <button
                            type="button"
                            className="button"
                            aria-label={`Restart from ${stage.name}`}
                            disabled={busy || !prefixReady}
                            onClick={() => void rerun(stage, index, true)}
                          >
                            <RotateCcw size={14} />
                            Restart
                          </button>
                        )}
                        {["blocked", "cancelled"].includes(run.status) &&
                          run.currentStage === stage.id && (
                            <button
                              type="button"
                              className="button"
                              aria-label={`Skip ${stage.name} stage`}
                              disabled={busy || !prefixReady}
                              onClick={() => {
                                setSkipStage(stage);
                                setSkipReason("");
                                setAllowPublication(false);
                                setError("");
                              }}
                            >
                              <SkipForward size={14} />
                              Skip
                            </button>
                          )}
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Rerun from ${stage.name}`}
                          title={
                            !inactive
                              ? "Stop or finish this run before rerunning"
                              : !prefixReady
                                ? "Earlier stages need accepted outputs without blockers first"
                                : `Rerun from ${stage.name}`
                          }
                          disabled={busy || !inactive || !prefixReady}
                          onClick={() => void rerun(stage, index)}
                        >
                          <RotateCcw size={15} />
                        </button>
                      </div>
                      {run.visits && (
                        <div
                          className="visit-history"
                          aria-label={`${stage.name} pass history`}
                        >
                          {run.visits
                            .filter((visit) => visit.stageId === stage.id)
                            .map((visit) => (
                              <details key={visit.id}>
                                <summary>
                                  Pass {visit.iteration}
                                  {visit.loopContext
                                    ? ` of up to ${visit.loopContext.maxIterations}`
                                    : ""}
                                  {visit.route
                                    ? ` — ${
                                        {
                                          repeat: `Repeat from ${run.stages.find((item) => item.id === visit.route?.targetStageId)?.name ?? visit.route.targetStageId}`,
                                          continue:
                                            "Condition did not match; continued",
                                          limit: "Pass limit reached; blocked",
                                          skipped:
                                            "Loop bypassed by owner; not approved",
                                        }[visit.route.kind]
                                      }`
                                    : ""}
                                </summary>
                                {visit.route && (
                                  <pre>
                                    {JSON.stringify(visit.route, null, 2)}
                                  </pre>
                                )}
                                {visit.loopContext && (
                                  <details>
                                    <summary>Incoming loop feedback</summary>
                                    <pre>
                                      {JSON.stringify(
                                        visit.loopContext.feedback,
                                        null,
                                        2,
                                      )}
                                    </pre>
                                  </details>
                                )}
                                {Object.entries(visit.units).map(
                                  ([key, unit]) => (
                                    <button
                                      type="button"
                                      className="button"
                                      key={key}
                                      onClick={() =>
                                        setSelectedUnit(`${visit.id}:${key}`)
                                      }
                                    >
                                      View {unit.name} pass {visit.iteration} (
                                      {unit.status})
                                    </button>
                                  ),
                                )}
                              </details>
                            ))}
                        </div>
                      )}
                    </div>
                    <div className="list-panel">
                      {contract && (
                        <div
                          className="contract-step"
                          role="status"
                          aria-label={contract.name}
                        >
                          <span>{contract.name}</span>
                          <ErrorNotice
                            error={contract.attempts.at(-1)?.error}
                          />
                        </div>
                      )}
                      {stage.agents.map((agent) => {
                        const key = `${stage.id}/${agent.id}`;
                        const unit = run.units[key];
                        const outcome = reportedOutcome(unit);
                        return unit ? (
                          <button
                            key={key}
                            type="button"
                            className="list-row activity-card"
                            aria-label={`View ${agent.name} input and output`}
                            onClick={() => setSelectedUnit(key)}
                          >
                            <div>
                              <strong>{agent.name}</strong>
                              <span>
                                {unit.reusedFrom
                                  ? "Reused handoff"
                                  : `${unit.attempts.length} attempt${unit.attempts.length !== 1 ? "s" : ""}`}
                              </span>
                            </div>
                            {outcome ? (
                              <StatusBadge status={outcome} />
                            ) : (
                              <span className="muted">
                                {unit.status === "completed"
                                  ? "Outcome not reported"
                                  : unit.status === "blocked" ||
                                      unit.status === "cancelled"
                                    ? `Execution ${unit.status}`
                                    : "Awaiting outcome"}
                              </span>
                            )}
                          </button>
                        ) : (
                          <div key={key} className="list-row pending-agent">
                            <div>
                              <strong>{agent.name}</strong>
                            </div>
                            <span>Not executed</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        </section>
        <section aria-labelledby="run-result-heading">
          <div className="section-heading">
            <h2 id="run-result-heading">Result</h2>
          </div>
          <div className="result-summary">
            {run.resultSummary?.status === "completed" ? (
              run.resultSummary.lines.map((line, index) => (
                <p key={index}>{line}</p>
              ))
            ) : run.resultSummary?.status === "generating" || summaryBusy ? (
              <p role="status">Generating result summary...</p>
            ) : (
              <p className="muted">
                {["queued", "running"].includes(run.status)
                  ? "The result will appear when the workflow finishes."
                  : "A human-readable result summary has not been generated yet."}
              </p>
            )}
            <ErrorNotice
              error={
                summaryError ||
                (run.resultSummary?.status === "failed"
                  ? run.resultSummary.error
                  : "")
              }
            />
            {!["queued", "running"].includes(run.status) &&
              run.resultSummary?.status !== "completed" &&
              run.resultSummary?.status !== "generating" && (
                <button
                  className="button"
                  disabled={summaryBusy}
                  onClick={() => void generateSummary()}
                >
                  {run.resultSummary?.status === "failed"
                    ? "Retry summary"
                    : "Generate summary"}
                </button>
              )}
          </div>
          {run.result !== undefined && (
            <details className="raw-result">
              <summary>Raw output</summary>
              <pre className="result-panel">
                {JSON.stringify(run.result, null, 2)}
              </pre>
            </details>
          )}
        </section>
      </div>
      <details className="logs">
        <summary>Execution logs</summary>
        <pre>{logs.data?.content || "No process logs yet."}</pre>
      </details>
      {selectedUnit && selectedRecord && (
        <RunUnitDetails
          key={`${run.id}/${selectedUnit}`}
          runId={run.id}
          unitKey={selectedUnit}
          name={selectedRecord.name}
          onClose={() => setSelectedUnit(undefined)}
        />
      )}
    </div>
  );
}
