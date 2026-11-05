import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import type { QueueState } from "../../shared/contracts.ts";
import { useResource } from "../api.ts";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
} from "../components.tsx";

export function Queue() {
  const { data, error } = useResource<QueueState>("/queue", true);
  return (
    <div className="page">
      <PageHeader
        eyebrow="ONE AT A TIME"
        title="Queue"
        description="The 30 most recent queue submissions, including finished runs."
      />
      <ErrorNotice error={error} />
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          <div className="collection-toolbar">
            <span>
              {data.pending} pending · {data.running} running
            </span>
          </div>
          {data.runs.length ? (
            <section className="list-panel" aria-label="Queue history">
              {data.runs.map((run) => (
                <Link key={run.id} className="list-row" to={`/runs/${run.id}`}>
                  <div>
                    <strong>{run.workflowName}</strong>
                    <span>
                      {run.trigger
                        ? `Watch: ${run.trigger.reason}`
                        : "Manual run"}{" "}
                      ·{" "}
                      {new Date(
                        run.enqueuedAt ?? run.createdAt,
                      ).toLocaleString()}
                    </span>
                  </div>
                  <StatusBadge
                    status={run.status}
                    label={run.status === "queued" ? "pending" : run.status}
                  />
                  <ExternalLink size={14} />
                </Link>
              ))}
            </section>
          ) : (
            <EmptyState
              title="Nothing queued yet"
              description="Enable Queued in workflow settings to run through the shared queue."
            />
          )}
        </>
      )}
    </div>
  );
}
