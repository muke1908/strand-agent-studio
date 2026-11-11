import { Plus, Trash2, X } from "lucide-react";
import { agentSchema, schema } from "../../shared/contracts.ts";
import type { Agent, Skill, Stage, Workflow } from "../../shared/contracts.ts";
import { JsonEditor } from "../components.tsx";
import { AgentInstructions } from "./agent-instructions.tsx";
import { StageLoop } from "./stage-loop.tsx";
import { isAction } from "../../shared/workflow-kind.ts";
import { ExpectedOutput } from "./expected-output.tsx";

export type Selection =
  | { kind: "workflow" }
  | { kind: "stage"; stageId: string }
  | { kind: "agent"; stageId: string; agentId: string };
type Props = {
  workflow: Workflow;
  selection: Selection;
  skills: Skill[];
  update: (workflow: Workflow) => void;
  close: () => void;
  blocked: boolean;
  disabled: boolean;
  error: (key: string, message: string) => void;
  addStage?: () => void;
};

export function Inspector({
  workflow,
  selection,
  skills,
  update,
  close,
  blocked,
  disabled,
  error,
  addStage,
}: Props) {
  const stage =
    selection.kind === "workflow"
      ? undefined
      : workflow.stages.find((item) => item.id === selection.stageId);
  const agent =
    selection.kind === "agent"
      ? stage?.agents.find((item) => item.id === selection.agentId)
      : undefined;
  function updateStage(next: Stage) {
    update({
      ...workflow,
      stages: workflow.stages.map((item) =>
        item.id === next.id ? next : item,
      ),
    });
  }
  function updateAgent(next: Agent) {
    if (stage)
      updateStage({
        ...stage,
        agents: stage.agents.map((item) => (item.id === next.id ? next : item)),
      });
  }
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">
            {selection.kind === "workflow" && isAction(workflow)
              ? "ACTION"
              : selection.kind.toUpperCase()}
          </span>
          <h2>
            {agent?.name ||
              stage?.name ||
              (isAction(workflow) ? "Action settings" : "Workflow settings")}
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close inspector"
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <fieldset
        className="inspector-content"
        disabled={disabled}
        style={{ border: 0, margin: 0, minWidth: 0 }}
      >
        {selection.kind === "workflow" ? (
          <>
            <label className="field">
              Name
              <input
                value={workflow.name}
                onChange={(event) =>
                  update({ ...workflow, name: event.target.value })
                }
              />
            </label>
            <label className="field">
              Description
              <textarea
                rows={3}
                value={workflow.description}
                onChange={(event) =>
                  update({ ...workflow, description: event.target.value })
                }
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={workflow.queued ?? false}
                onChange={(event) =>
                  update({ ...workflow, queued: event.target.checked })
                }
                aria-describedby="workflow-queue-help"
              />
              Queued
            </label>
            <p className="muted" id="workflow-queue-help">
              Run through the shared queue, one at a time. Unchecked items can
              still run in parallel.
            </p>
            {!isAction(workflow) && (
              <JsonEditor
                label="Launch input schema"
                value={workflow.inputSchema}
                onChange={(value) =>
                  update({
                    ...workflow,
                    expectedInput: undefined,
                    inputSchema: schema.parse(value),
                  })
                }
                onError={(message) => error("input-schema", message)}
              />
            )}
            {addStage && (
              <button
                className="button"
                disabled={blocked}
                onClick={() => {
                  addStage();
                  close();
                }}
              >
                <Plus size={14} />
                Convert to workflow
              </button>
            )}
          </>
        ) : agent ? (
          <>
            <label className="field">
              Agent name
              <input
                value={agent.name}
                onChange={(event) =>
                  updateAgent({ ...agent, name: event.target.value })
                }
              />
            </label>
            <label className="field">
              Model
              <input
                placeholder="Backend default"
                value={agent.model || ""}
                onChange={(event) =>
                  updateAgent({
                    ...agent,
                    model: event.target.value || undefined,
                  })
                }
              />
            </label>
            <AgentInstructions
              key={`instructions-${stage?.id}/${agent.id}`}
              agent={agent}
              onChange={updateAgent}
              workflowId={workflow.id}
            />
            <p className="muted">
              All agents share the folders configured by STRAND_PATH_* in the
              local environment. Use get_path to look up a named folder.
            </p>
            <SkillPicker
              selected={agent.skills}
              skills={skills}
              onChange={(ids) => updateAgent({ ...agent, skills: ids })}
            />
            {stage && stage.agents.length > 1 && (
              <button
                className="button danger"
                disabled={blocked}
                onClick={() => {
                  updateStage({
                    ...stage,
                    agents: stage.agents.filter((item) => item.id !== agent.id),
                  });
                  close();
                }}
              >
                <Trash2 size={14} />
                Remove agent
              </button>
            )}
          </>
        ) : (
          stage && (
            <>
              <label className="field">
                Stage name
                <input
                  value={stage.name}
                  onChange={(event) =>
                    updateStage({ ...stage, name: event.target.value })
                  }
                />
              </label>
              <StageLoop
                key={stage.id}
                stage={stage}
                workflow={workflow}
                update={updateStage}
                error={error}
              />
              <SkillPicker
                selected={stage.skills}
                skills={skills}
                onChange={(ids) => updateStage({ ...stage, skills: ids })}
              />
              <ExpectedOutput stage={stage} onChange={updateStage} />
              <button
                className="button"
                onClick={() =>
                  updateStage({
                    ...stage,
                    agents: [
                      ...stage.agents,
                      agentSchema.parse({
                        id: `agent-${crypto.randomUUID().slice(0, 8)}`,
                        name: "New agent",
                      }),
                    ],
                  })
                }
              >
                <Plus size={14} />
                Add agent
              </button>
              {workflow.stages.length > 1 && (
                <button
                  className="button danger"
                  disabled={blocked}
                  onClick={() => {
                    update({
                      ...workflow,
                      stages: workflow.stages.filter(
                        (item) => item.id !== stage.id,
                      ),
                    });
                    close();
                  }}
                >
                  <Trash2 size={14} />
                  Remove stage
                </button>
              )}
            </>
          )
        )}
      </fieldset>
    </aside>
  );
}

function SkillPicker({
  skills,
  selected,
  onChange,
}: {
  skills: Skill[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="skill-picker">
      <legend>Skills</legend>
      {skills.length ? (
        skills.map((skill) => (
          <label key={skill.id}>
            <input
              type="checkbox"
              checked={selected.includes(skill.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, skill.id]
                    : selected.filter((id) => id !== skill.id),
                )
              }
            />
            <span>
              {skill.name}
              <small>{skill.description}</small>
            </span>
          </label>
        ))
      ) : (
        <p className="muted">Create a skill in the Skills gallery.</p>
      )}
    </fieldset>
  );
}
