import { Link } from "react-router-dom";
import { ArrowRight, Plus, Radio } from "lucide-react";
import type {
  RunSummary,
  Saved,
  Workflow,
  Watch,
} from "../../shared/contracts.ts";
import { useResource } from "../api.ts";
import { ErrorNotice, PageHeader, StatusBadge } from "../components.tsx";
import { WorkflowCard } from "./workflows.tsx";
import { isAction } from "../../shared/workflow-kind.ts";

export function Overview() {
  const workflows = useResource<Saved<Workflow>[]>("/pipelines");
  const runs = useResource<RunSummary[]>("/pipeline-runs", true);
  const watches = useResource<Saved<Watch>[]>("/pipeline-watches");
  const processes = workflows.data?.filter(({ value }) => !isAction(value));
  const actions = workflows.data?.filter(({ value }) => isAction(value));
  return (
    <div className="page">
      <PageHeader
        eyebrow="YOUR AGENT WORKSPACE"
        title="Make good work repeatable."
        description="Run a focused action or connect steps into a workflow."
      >
        <Link className="button primary" to="/pipelines/new">
          <Plus size={16} />
          New workflow
        </Link>
      </PageHeader>
      <ErrorNotice error={workflows.error || runs.error || watches.error} />
      <div className="stats-strip">
        <div>
          <span>Workflows</span>
          <strong>{processes?.length ?? "—"}</strong>
        </div>
        <div>
          <span>Actions</span>
          <strong>{actions?.length ?? "—"}</strong>
        </div>
        <div>
          <span>Active runs</span>
          <strong>
            {runs.data?.filter((run) =>
              ["running", "queued"].includes(run.status),
            ).length ?? "—"}
          </strong>
        </div>
        <div>
          <span>Watching</span>
          <strong>
            {watches.data?.filter((item) => item.value.enabled).length ?? "—"}
          </strong>
        </div>
        <div className="stats-note">
          <Radio size={17} />
          <span>Ready when your process is.</span>
        </div>
      </div>
      <section aria-label="Your workflows">
        <div className="section-heading">
          <h2>Your workflows</h2>
          <Link to="/pipelines">
            View all <ArrowRight size={14} />
          </Link>
        </div>
        <div className="card-grid">
          {processes?.slice(0, 3).map(({ value }) => (
            <WorkflowCard key={value.id} workflow={value} />
          ))}
        </div>
      </section>
      <section aria-label="Your actions">
        <div className="section-heading">
          <h2>Your actions</h2>
          <Link to="/actions">
            View all <ArrowRight size={14} />
          </Link>
        </div>
        <div className="card-grid">
          {actions?.slice(0, 3).map(({ value }) => (
            <WorkflowCard key={value.id} workflow={value} />
          ))}
        </div>
      </section>
      {(["workflow", "action"] as const).map((kind) => {
        const recent = runs.data
          ?.filter((run) => run.kind === kind)
          .slice(0, 5);
        const title = `Recent ${kind} runs`;
        return (
          <section key={kind} aria-label={title}>
            <div className="section-heading">
              <h2>{title}</h2>
              <Link to={kind === "action" ? "/action-runs" : "/runs"}>
                View all <ArrowRight size={14} />
              </Link>
            </div>
            <div className="list-panel">
              {recent?.length ? (
                recent.map((run) => (
                  <Link
                    key={run.id}
                    className="list-row"
                    to={`/runs/${run.id}`}
                  >
                    <div>
                      <strong>{run.workflowName}</strong>
                      <span>
                        {run.trigger ? run.trigger.reason : "Manual run"}
                      </span>
                    </div>
                    <StatusBadge status={run.status} />
                  </Link>
                ))
              ) : (
                <div className="quiet-empty">No {kind} runs yet.</div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
