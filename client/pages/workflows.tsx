import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Plus,
  Search,
  GitBranch,
  Users,
  Zap,
} from "lucide-react";
import type { Saved, Workflow } from "../../shared/contracts.ts";
import { useResource } from "../api.ts";
import { isAction, workflowPath } from "../../shared/workflow-kind.ts";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
} from "../components.tsx";

export function WorkflowCard({ workflow }: { workflow: Workflow }) {
  const action = isAction(workflow);
  const agents = workflow.stages.reduce(
    (sum, stage) => sum + stage.agents.length,
    0,
  );
  return (
    <Link className="workflow-card" to={workflowPath(workflow)}>
      <div className="card-top">
        <span className="workflow-icon">
          {action ? <Zap size={20} /> : <GitBranch size={20} />}
        </span>
        <ArrowUpRight size={17} />
      </div>
      <h3>{workflow.name}</h3>
      <p>
        {workflow.description ||
          (action
            ? "One focused task, ready to run."
            : "Your next agent workflow.")}
      </p>
      <div className="stage-preview">
        {workflow.stages.map((stage, index) => (
          <span key={stage.id}>
            {index > 0 && <i />}
            {stage.name}
          </span>
        ))}
      </div>
      <div className="card-footer">
        <span>
          {action ? "Single step" : `${workflow.stages.length} stages`}
        </span>
        <span>
          <Users size={13} />
          {agents} {agents === 1 ? "agent" : "agents"}
        </span>
      </div>
    </Link>
  );
}
export function Workflows({ actions = false }: { actions?: boolean }) {
  const { data, error } = useResource<Saved<Workflow>[]>("/pipelines");
  const [search, setSearch] = useState("");
  const title = actions ? "Actions" : "Workflows";
  const singular = actions ? "action" : "workflow";
  const collection = data?.filter(({ value }) => isAction(value) === actions);
  const filtered = collection?.filter(({ value }) =>
    `${value.name} ${value.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="page">
      <PageHeader
        eyebrow={actions ? "ONE TASK. DONE WELL." : "COMPOSE YOUR PROCESS"}
        title={title}
        description={
          actions
            ? "Focused, single-step tasks. Check your PR inbox, count open comments, and more."
            : "Connect steps and agents into a repeatable process."
        }
      >
        <Link
          className="button primary"
          to={actions ? "/actions/new" : "/pipelines/new"}
        >
          <Plus size={16} />
          New {singular}
        </Link>
      </PageHeader>
      <ErrorNotice error={error} />
      <div className="collection-toolbar">
        <span>
          {collection?.length ?? 0} {title.toLowerCase()}
        </span>
        <label className="search">
          <Search size={15} />
          <input
            aria-label={`Search ${title.toLowerCase()}`}
            placeholder={`Search ${title.toLowerCase()}`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {!data ? (
        <Loading />
      ) : filtered?.length ? (
        <div className="card-grid">
          {filtered.map(({ value }) => (
            <WorkflowCard key={value.id} workflow={value} />
          ))}
        </div>
      ) : (
        <EmptyState
          title={actions ? "Your next small win" : "A clean canvas"}
          description={`Create ${actions ? "an action" : "a workflow"} or try another search.`}
        />
      )}
    </div>
  );
}
