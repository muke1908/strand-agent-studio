import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Plus, Search, GitBranch, Users } from "lucide-react";
import type { Saved, Workflow } from "../../shared/contracts.ts";
import { useResource } from "../api.ts";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
} from "../components.tsx";

export function WorkflowCard({ workflow }: { workflow: Workflow }) {
  return (
    <Link className="workflow-card" to={`/pipelines/${workflow.id}`}>
      <div className="card-top">
        <span className="workflow-icon">
          <GitBranch size={20} />
        </span>
        <ArrowUpRight size={17} />
      </div>
      <h3>{workflow.name}</h3>
      <p>{workflow.description || "Your next agent workflow."}</p>
      <div className="stage-preview">
        {workflow.stages.map((stage, index) => (
          <span key={stage.id}>
            {index > 0 && <i />}
            {stage.name}
          </span>
        ))}
      </div>
      <div className="card-footer">
        <span>{workflow.stages.length} stages</span>
        <span>
          <Users size={13} />
          {workflow.stages.reduce(
            (sum, stage) => sum + stage.agents.length,
            0,
          )}{" "}
          agents
        </span>
      </div>
    </Link>
  );
}
export function Workflows() {
  const { data, error } = useResource<Saved<Workflow>[]>("/pipelines");
  const [search, setSearch] = useState("");
  const filtered = data?.filter(({ value }) =>
    `${value.name} ${value.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="page">
      <PageHeader
        eyebrow="COMPOSE YOUR PROCESS"
        title="Workflows"
        description="Small steps. Capable agents. A process that’s yours."
      >
        <Link className="button primary" to="/pipelines/new">
          <Plus size={16} />
          New workflow
        </Link>
      </PageHeader>
      <ErrorNotice error={error} />
      <div className="collection-toolbar">
        <span>{data?.length ?? 0} workflows</span>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search workflows"
            placeholder="Search workflows"
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
          title="A clean canvas"
          description="Create a workflow or try another search."
        />
      )}
    </div>
  );
}
