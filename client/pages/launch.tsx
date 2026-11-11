import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Play } from "lucide-react";
import type { Json, Run, Saved, Workflow } from "../../shared/contracts.ts";
import { api, errorMessage, useResource } from "../api.ts";
import { ErrorNotice, Loading, PageHeader } from "../components.tsx";
import { JsonInput, SchemaForm, supportsForm } from "../forms/schema-form.tsx";
import { validateJson } from "../../shared/json-schema.ts";
import { isAction, workflowPath } from "../../shared/workflow-kind.ts";

export function Launch() {
  const { id } = useParams();
  const resource = useResource<Saved<Workflow>>(`/pipelines/${id}`);
  const settings = useResource<{
    backend: { available: boolean; reason?: string };
  }>("/settings");
  const [input, setInput] = useState<Record<string, Json>>({});
  const [raw, setRaw] = useState<Json | undefined>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [allowAllTools, setAllowAllTools] = useState(false);
  const submission = useRef<{ digest: string; requestId: string }>();
  const navigate = useNavigate();
  async function launch(event: React.FormEvent) {
    event.preventDefault();
    if (!resource.data) return;
    setBusy(true);
    setError("");
    try {
      const submittedInput = supportsForm(resource.data.value.inputSchema)
        ? input
        : raw;
      if (submittedInput === undefined)
        throw new Error("Enter valid JSON input.");
      validateJson(resource.data.value.inputSchema, submittedInput);
      const digest = JSON.stringify({
        id,
        input: submittedInput,
        allowAllTools,
      });
      if (submission.current?.digest !== digest)
        submission.current = { digest, requestId: crypto.randomUUID() };
      const run = await api<Run>(`/pipelines/${id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          input: submittedInput,
          requestId: submission.current.requestId,
          allowAllTools,
        }),
      });
      navigate(`/runs/${run.id}`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  if (!resource.data)
    return (
      <div className="page">
        <ErrorNotice error={resource.error} />
        <Loading />
      </div>
    );
  return (
    <div className="page narrow">
      <Link className="back-link" to={workflowPath(resource.data.value)}>
        <ArrowLeft size={14} />
        Back to {isAction(resource.data.value) ? "action" : "workflow"}
      </Link>
      <PageHeader
        eyebrow="START A RUN"
        title={resource.data.value.name}
        description="Give your agents the context they need. Every run keeps its own snapshot."
      />
      <ErrorNotice error={resource.error || settings.error || error} />
      {settings.data && !settings.data.backend.available && (
        <ErrorNotice error={settings.data.backend.reason} />
      )}
      <form className="form-panel" onSubmit={(event) => void launch(event)}>
        {supportsForm(resource.data.value.inputSchema) ? (
          <SchemaForm
            schema={resource.data.value.inputSchema}
            value={input}
            onChange={(value) => {
              setInput(value);
              setError("");
            }}
          />
        ) : (
          <>
            <p className="muted">
              This schema uses advanced fields. Enter JSON; the same schema is
              validated on the server.
            </p>
            <JsonInput
              onChange={(value, message) => {
                setRaw(value);
                setError(message);
              }}
            />
          </>
        )}
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={allowAllTools}
            onChange={(event) => setAllowAllTools(event.target.checked)}
            disabled={busy}
            aria-describedby="tool-permission-help"
          />
          Allow all tools
        </label>
        <p className="muted" id="tool-permission-help">
          Enables web, shell and MCP tools with automatic tool and URL approval.
          Tools can change files and access external services. Use only trusted
          instructions.
        </p>
        <div className="form-footer">
          <span>
            {isAction(resource.data.value)
              ? "Single step"
              : `${resource.data.value.stages.length} stages`}{" "}
            · pinned instructions
          </span>
          <button
            className="button primary"
            disabled={
              busy ||
              settings.data?.backend.available === false ||
              raw === undefined
            }
          >
            <Play size={15} />
            {resource.data.value.queued
              ? busy
                ? "Adding…"
                : "Add to queue"
              : busy
                ? "Starting…"
                : isAction(resource.data.value)
                  ? "Run action"
                  : "Run workflow"}
          </button>
        </div>
      </form>
    </div>
  );
}
