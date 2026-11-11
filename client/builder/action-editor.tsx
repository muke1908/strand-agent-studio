import type { Agent, Workflow } from "../../shared/contracts.ts";
import { errorMessage } from "../api.ts";
import { AgentInstructions } from "./agent-instructions.tsx";
import { ExpectedOutput } from "./expected-output.tsx";

export function ActionEditor({
  workflow,
  update,
  disabled,
  error,
  uploading,
}: {
  workflow: Workflow;
  update: (workflow: Workflow) => void;
  disabled: boolean;
  error: (key: string, message: string) => void;
  uploading: (pending: boolean) => void;
}) {
  const stage = workflow.stages[0];
  function updateAgent(agent: Agent) {
    update({
      ...workflow,
      stages: [
        {
          ...stage,
          agents: stage.agents.map((item) =>
            item.id === agent.id ? agent : item,
          ),
        },
      ],
    });
    error(`instructions-${agent.id}`, "");
  }
  async function upload(file: File, agent: Agent) {
    const key = `instructions-${agent.id}`;
    uploading(true);
    try {
      if (!file.name.toLowerCase().endsWith(".md"))
        throw new Error("Choose a Markdown (.md) file.");
      if (file.size > 200000)
        throw new Error(
          "Markdown instructions cannot exceed 50,000 characters.",
        );
      const instructions = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (!instructions.trim())
        throw new Error("Markdown instructions cannot be empty.");
      if (instructions.length > 50000)
        throw new Error(
          "Markdown instructions cannot exceed 50,000 characters.",
        );
      updateAgent({ ...agent, instructionsFile: undefined, instructions });
    } catch (failure) {
      error(key, errorMessage(failure));
    } finally {
      uploading(false);
    }
  }
  return (
    <div className="action-editor">
      <fieldset className="form-panel" disabled={disabled}>
        <div className="action-schemas">
          <label className="field">
            Expected input
            <textarea
              rows={5}
              maxLength={50000}
              placeholder="For example: A required repository URL and an optional maximum number of PRs to check."
              value={workflow.expectedInput ?? ""}
              onChange={(event) =>
                update({ ...workflow, expectedInput: event.target.value })
              }
            />
            <small>
              Describe the inputs in plain language. The launch form is
              generated when you save. Leave empty for no inputs.
              {workflow.expectedInput === undefined &&
                " This saved action keeps its current input fields until you edit this description."}
            </small>
          </label>
          <ExpectedOutput
            stage={stage}
            onChange={(next) =>
              update({
                ...workflow,
                stages: [next],
              })
            }
          />
        </div>
        <section aria-label="Markdown instructions">
          <h2>Markdown instructions</h2>
          {stage.agents.map((agent) => (
            <div key={agent.id}>
              {stage.agents.length > 1 && <h3>{agent.name}</h3>}
              {agent.instructionsFile && (
                <AgentInstructions
                  agent={agent}
                  onChange={updateAgent}
                  workflowId={workflow.id}
                />
              )}
              <div className="field">
                <label htmlFor={`markdown-${agent.id}`}>
                  {stage.agents.length > 1
                    ? `Upload Markdown for ${agent.name}`
                    : "Upload Markdown"}
                </label>
                <input
                  id={`markdown-${agent.id}`}
                  type="file"
                  accept=".md,text/markdown"
                  aria-describedby={`markdown-help-${agent.id}`}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file, agent);
                    event.target.value = "";
                  }}
                />
                <small id={`markdown-help-${agent.id}`}>
                  .md files, up to 50,000 characters. Uploaded instructions are
                  saved with this action.
                </small>
              </div>
              {agent.instructions && (
                <details className="action-instructions-preview">
                  <summary>View saved instructions</summary>
                  <pre>{agent.instructions}</pre>
                </details>
              )}
            </div>
          ))}
        </section>
      </fieldset>
    </div>
  );
}
