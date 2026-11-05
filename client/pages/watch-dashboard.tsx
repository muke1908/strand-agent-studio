import { Link } from "react-router-dom";
import { Radio } from "lucide-react";
import type { Json, WatchDashboardItem } from "../../shared/contracts.ts";
import { useResource } from "../api.ts";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
} from "../components.tsx";
import { WatchTiming } from "../watch-timing.tsx";

function WatchOutput({ output }: { output: Json }) {
  const record =
    output !== null && typeof output === "object" && !Array.isArray(output)
      ? output
      : undefined;
  const summary = typeof record?.summary === "string" ? record.summary : "";
  const metrics = Object.entries(record ?? {}).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  const raw = (
    <pre className="result-panel">{JSON.stringify(output, null, 2)}</pre>
  );
  return (
    <div className="watch-output">
      {summary && <p>{summary}</p>}
      {metrics.length > 0 && (
        <dl className="watch-metrics">
          {metrics.map(([key, value]) => (
            <div key={key}>
              <dt>
                {key
                  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
                  .replace(/[_-]/g, " ")
                  .replace(/\bpr\b/gi, "PR")}
              </dt>
              <dd>{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}
      {summary || metrics.length ? (
        <details className="raw-result">
          <summary>View full output</summary>
          {raw}
        </details>
      ) : (
        raw
      )}
    </div>
  );
}

export function WatchDashboard() {
  const resource = useResource<WatchDashboardItem[]>("/watch-dashboard", true);
  return (
    <div className="page">
      <PageHeader
        eyebrow="YOUR WATCHER RESULTS"
        title="Dashboard"
        description="One card per watch. Live run status and the latest output, without opening the execution history."
      >
        <Link className="button" to="/watches">
          <Radio size={16} />
          Manage watches
        </Link>
      </PageHeader>
      <ErrorNotice error={resource.error} />
      {!resource.data ? (
        !resource.error && <Loading />
      ) : !resource.data.length ? (
        <EmptyState
          title="No watches yet"
          description="Add a watch to see its scheduled workflow output here."
        >
          <Link className="button" to="/watches">
            Set up a watch
          </Link>
        </EmptyState>
      ) : (
        <div className="watch-grid">
          {resource.data.map(
            ({ value: watch, state, latestRun, previousResultRun }) => {
              const output =
                latestRun?.result !== undefined
                  ? latestRun.result
                  : previousResultRun?.result;
              return (
                <article
                  key={watch.id}
                  className="watch-card watch-result-card"
                  aria-labelledby={`watch-title-${watch.id}`}
                >
                  <header className="watch-result-title">
                    <h2 id={`watch-title-${watch.id}`}>{watch.name}</h2>
                    <StatusBadge
                      status={
                        watch.enabled ? (state.phase ?? "watching") : "paused"
                      }
                    />
                  </header>
                  <p>
                    {watch.workflowId}
                    {watch.action && ` → ${watch.action.workflowId}`}
                  </p>
                  <WatchTiming watch={watch} state={state} />
                  {watch.action &&
                    state.decisions.findLast((entry) => entry.action?.runId)
                      ?.action?.runId && (
                      <Link
                        to={`/runs/${state.decisions.findLast((entry) => entry.action?.runId)!.action!.runId}`}
                      >
                        Open latest action
                      </Link>
                    )}
                  <ErrorNotice error={state.error} />
                  {latestRun ? (
                    <>
                      <div className="watch-result-run">
                        <StatusBadge status={latestRun.status} />
                        <Link to={`/runs/${latestRun.id}`}>
                          Open latest run
                        </Link>
                      </div>
                      <p className="watch-meta">
                        Run updated:{" "}
                        <time dateTime={latestRun.updatedAt}>
                          {new Date(latestRun.updatedAt).toLocaleString()}
                        </time>
                      </p>
                      <ErrorNotice error={latestRun.error} />
                      {latestRun.result === undefined && previousResultRun && (
                        <p className="watch-meta">
                          Showing previous result from{" "}
                          <Link
                            to={`/runs/${previousResultRun.id}`}
                            aria-label="Open previous result run"
                          >
                            <time dateTime={previousResultRun.updatedAt}>
                              {new Date(
                                previousResultRun.updatedAt,
                              ).toLocaleString()}
                            </time>
                          </Link>
                          .
                        </p>
                      )}
                      {output !== undefined ? (
                        <WatchOutput output={output} />
                      ) : (
                        <p className="muted">
                          {["queued", "running"].includes(latestRun.status)
                            ? "Check in progress. No result yet."
                            : "No result was produced. Open the run for details."}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="muted">
                      Waiting for the first scheduled run.
                    </p>
                  )}
                </article>
              );
            },
          )}
        </div>
      )}
    </div>
  );
}
