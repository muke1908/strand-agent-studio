import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Background, Controls, ReactFlow, useNodesState } from "@xyflow/react";
import type { Connection, Edge, NodeChange } from "@xyflow/react";
import {
  ArrowLeft,
  Copy,
  Plus,
  Save,
  Settings2,
  Play,
  Trash2,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import { stageSchema, workflowSchema } from "../../shared/contracts.ts";
import type { Saved, Skill, Workflow } from "../../shared/contracts.ts";
import { validateReferences } from "../../shared/bindings.ts";
import { api, errorMessage, useResource } from "../api.ts";
import { ErrorNotice, Loading } from "../components.tsx";
import { Inspector } from "./inspector.tsx";
import type { Selection } from "./inspector.tsx";
import { StageNode } from "./stage-node.tsx";
import type { StageCanvasNode } from "./stage-node.tsx";

const nodeTypes = { stage: StageNode };
const newStage = () =>
  stageSchema.parse({
    id: `step-${crypto.randomUUID().slice(0, 8)}`,
    name: "New stage",
    outputSchema: {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    },
    agents: [{ id: "agent", name: "Agent" }],
  });
const newWorkflow = () =>
  workflowSchema.parse({
    id: `workflow-${crypto.randomUUID().slice(0, 8)}`,
    name: "Untitled workflow",
    description: "",
    inputSchema: {
      type: "object",
      required: ["context"],
      properties: {
        context: { type: "string", title: "Context", minLength: 1 },
      },
    },
    stages: [newStage()],
  });

export function WorkflowBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const resource = useResource<Saved<Workflow>>(
    id ? `/pipelines/${id}` : undefined,
  );
  const skills = useResource<Saved<Skill>[]>("/skills");
  const [workflow, setWorkflow] = useState<Workflow>(newWorkflow);
  const [revision, setRevision] = useState<string>();
  const [selection, setSelection] = useState<Selection>();
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const mutationLocked = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [dirty, setDirty] = useState(!id);
  const [nodes, setNodes, onNodesChange] = useNodesState<StageCanvasNode>([]);
  function select(next?: Selection) {
    if (Object.values(invalid).some(Boolean)) {
      setError("Fix invalid JSON before leaving this inspector.");
      return;
    }
    setSelection(next);
  }
  useEffect(() => {
    if (id && resource.data && "value" in resource.data) {
      setWorkflow(resource.data.value);
      setRevision(resource.data.revision);
      setDirty(false);
      setSelection(undefined);
    } else if (!id) {
      setWorkflow(newWorkflow());
      setRevision(undefined);
      setDirty(true);
    }
  }, [id, resource.data]);
  useEffect(() => {
    setNodes((current) =>
      workflow.stages.map((stage, index) => ({
        ...current.find((item) => item.id === stage.id),
        id: stage.id,
        type: "stage",
        ariaLabel: `${stage.name} stage`,
        position: workflow.layout[stage.id] ||
          current.find((item) => item.id === stage.id)?.position || {
            x: index * 330,
            y: 120,
          },
        selected:
          selection?.kind !== "workflow" && selection?.stageId === stage.id,
        data: {
          stage,
          index,
          selectStage: () => select({ kind: "stage", stageId: stage.id }),
          selectAgent: (agentId: string) =>
            select({ kind: "agent", stageId: stage.id, agentId }),
          selectedAgent:
            selection?.kind === "agent" && selection.stageId === stage.id
              ? selection.agentId
              : undefined,
        },
        deletable: false,
      })),
    );
  }, [workflow, selection, setNodes, invalid]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") select();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [invalid]);
  const edges = useMemo<Edge[]>(
    () =>
      workflow.stages.slice(1).map((stage, index) => ({
        id: `${workflow.stages[index].id}-${stage.id}`,
        source: workflow.stages[index].id,
        target: stage.id,
        type: "smoothstep",
        style: { stroke: "#b8b4cb", strokeWidth: 1.5 },
        deletable: false,
      })),
    [workflow],
  );
  function update(next: Workflow) {
    if (mutationLocked.current) return;
    setWorkflow(next);
    setDirty(true);
  }
  function changeNodes(changes: NodeChange<StageCanvasNode>[]) {
    if (mutationLocked.current) return;
    onNodesChange(changes);
    const positions = changes.filter(
      (change) =>
        change.type === "position" && change.position && !change.dragging,
    );
    if (!positions.length) return;
    const layout = { ...workflow.layout };
    for (const change of positions)
      if (change.type === "position" && change.position)
        layout[change.id] = change.position;
    update({ ...workflow, layout });
  }
  function connect(connection: Connection) {
    if (mutationLocked.current) return;
    if (
      !connection.source ||
      !connection.target ||
      connection.source === connection.target
    ) {
      setError("Connect two different stages.");
      return;
    }
    const stages = [...workflow.stages];
    const source = stages.findIndex((stage) => stage.id === connection.source);
    const target = stages.findIndex((stage) => stage.id === connection.target);
    if (source < 0 || target < 0) return;
    const [moved] = stages.splice(target, 1);
    const after = stages.findIndex((stage) => stage.id === connection.source);
    stages.splice(after + 1, 0, moved);
    try {
      validateReferences({ ...workflow, stages });
      update({ ...workflow, stages });
      setError("");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  async function save(duplicate = false) {
    if (mutationLocked.current) return;
    mutationLocked.current = true;
    setBusy(true);
    setError("");
    try {
      if (Object.values(invalid).some(Boolean))
        throw new Error("Fix the invalid JSON fields before saving.");
      const next = workflowSchema.parse(
        duplicate
          ? {
              ...workflow,
              id: `workflow-${crypto.randomUUID().slice(0, 8)}`,
              name: `${workflow.name} copy`,
            }
          : workflow,
      );
      validateReferences(next);
      const saved = await api<Saved<Workflow>>(`/pipelines/${next.id}`, {
        method: "PUT",
        body: JSON.stringify({
          value: next,
          revision: duplicate ? undefined : revision,
        }),
      });
      setWorkflow(saved.value);
      setRevision(saved.revision);
      setDirty(false);
      setSelection(undefined);
      navigate(`/pipelines/${saved.value.id}`, { replace: true });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      mutationLocked.current = false;
      setBusy(false);
    }
  }
  async function deleteWorkflow() {
    if (!id || !revision) return;
    if (
      !window.confirm(
        `Delete "${workflow.name}"? Existing runs and results will be kept. Unsaved changes will be discarded.`,
      )
    )
      return;
    mutationLocked.current = true;
    setBusy(true);
    setDeleting(true);
    setError("");
    try {
      await api(`/pipelines/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision }),
      });
      navigate("/pipelines", { replace: true });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      mutationLocked.current = false;
      setBusy(false);
      setDeleting(false);
    }
  }
  if (id && (!resource.data || resource.data.value.id !== id))
    return (
      <div className="page">
        <ErrorNotice error={resource.error} />
        {!resource.error && <Loading />}
      </div>
    );
  return (
    <div className="builder-page">
      <header className="builder-header">
        <Link
          to="/pipelines"
          className="icon-button"
          aria-label="Back to workflows"
        >
          <ArrowLeft size={18} />
        </Link>
        <div className="builder-title">
          <h1>{workflow.name}</h1>
          <span>
            {dirty ? "Unsaved changes" : "All changes saved"} ·{" "}
            {workflow.stages.length} stages
          </span>
        </div>
        <button className="button" onClick={() => select({ kind: "workflow" })}>
          <Settings2 size={15} />
          Settings
        </button>
        <button
          className="icon-button"
          aria-label="Duplicate workflow"
          disabled={busy}
          onClick={() => void save(true)}
        >
          <Copy size={16} />
        </button>
        {revision && !dirty && (
          <Link className="button" to={`/pipelines/${workflow.id}/run`}>
            <Play size={14} />
            Run
          </Link>
        )}
        {id && revision && (
          <button
            className="button danger"
            disabled={busy}
            onClick={() => void deleteWorkflow()}
          >
            <Trash2 size={14} />
            {deleting ? "Deleting…" : "Delete"}
          </button>
        )}
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void save()}
        >
          <Save size={15} />
          {busy && !deleting ? "Saving…" : "Save"}
        </button>
      </header>
      <ErrorNotice
        error={
          error ||
          resource.error ||
          skills.error ||
          Object.values(invalid).find(Boolean)
        }
      />
      <div className="builder-body">
        <div className="canvas">
          <div className="canvas-toolbar">
            <span>WORKFLOW CANVAS</span>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                update({
                  ...workflow,
                  stages: [...workflow.stages, newStage()],
                })
              }
            >
              <Plus size={15} />
              Add stage
            </button>
          </div>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={changeNodes}
            onNodeDragStop={(_event, node) =>
              update({
                ...workflow,
                layout: { ...workflow.layout, [node.id]: node.position },
              })
            }
            onConnect={connect}
            nodesDraggable={!busy}
            nodesConnectable={!busy}
            onPaneClick={() => select()}
            fitView
            minZoom={0.25}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#d5d5d1" gap={22} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
          <div className="canvas-hint">
            Drag to arrange · Connect to reorder · Click an agent to configure
          </div>
        </div>
        {selection && (
          <Inspector
            workflow={workflow}
            selection={selection}
            skills={skills.data?.map((item) => item.value) || []}
            update={update}
            close={() => select()}
            blocked={Object.values(invalid).some(Boolean)}
            disabled={busy}
            error={(key, message) =>
              setInvalid((current) => ({ ...current, [key]: message }))
            }
          />
        )}
      </div>
    </div>
  );
}
