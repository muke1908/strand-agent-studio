import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStore,
  useNodesState,
} from "@xyflow/react";
import type { Connection, Edge, NodeChange } from "@xyflow/react";
import {
  ArrowLeft,
  Copy,
  Plus,
  Save,
  Settings2,
  Play,
  Trash2,
  Repeat2,
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
import { describeLoopCondition } from "./loop-labels.ts";
import { isAction, workflowPath } from "../../shared/workflow-kind.ts";
import { ActionEditor } from "./action-editor.tsx";

const nodeTypes = { stage: StageNode };
const newStage = () =>
  stageSchema.parse({
    id: `step-${crypto.randomUUID().slice(0, 8)}`,
    name: "New stage",
    expectedOutput: "Return a concise summary of the result.",
    outputSchema: {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    },
    agents: [{ id: "agent", name: "Agent" }],
  });
const newWorkflow = (action: boolean) =>
  workflowSchema.parse({
    id: `workflow-${crypto.randomUUID().slice(0, 8)}`,
    name: action ? "Untitled action" : "Untitled workflow",
    description: "",
    ...(action
      ? {
          expectedInput: "A required Context text field describing what to do.",
        }
      : {}),
    inputSchema: {
      type: "object",
      required: ["context"],
      properties: {
        context: { type: "string", title: "Context", minLength: 1 },
      },
    },
    stages: action ? [newStage()] : [newStage(), newStage()],
  });

export function WorkflowBuilder({ action = false }: { action?: boolean }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const resource = useResource<Saved<Workflow>>(
    id ? `/pipelines/${id}` : undefined,
  );
  const skills = useResource<Saved<Skill>[]>("/skills");
  const [workflow, setWorkflow] = useState<Workflow>(() => newWorkflow(action));
  const actionItem = isAction(workflow);
  const collectionPath = actionItem ? "/actions" : "/pipelines";
  const [revision, setRevision] = useState<string>();
  const [selection, setSelection] = useState<Selection>();
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const mutationLocked = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [dirty, setDirty] = useState(!id);
  const [nodes, setNodes, onNodesChange] = useNodesState<StageCanvasNode>([]);
  function fieldError(key: string, message: string) {
    setInvalid((current) => ({ ...current, [key]: message }));
    setError("");
  }
  function select(next?: Selection) {
    if (Object.values(invalid).some(Boolean)) {
      setError("Fix invalid fields before continuing.");
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
      setWorkflow(newWorkflow(action));
      setRevision(undefined);
      setDirty(true);
    }
  }, [id, resource.data, action]);
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
          loopTargetName: workflow.stages.find(
            (item) => item.id === stage.loop?.targetStageId,
          )?.name,
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
    () => [
      ...workflow.stages.slice(1).map((stage, index) => ({
        id: `${workflow.stages[index].id}-${stage.id}`,
        source: workflow.stages[index].id,
        target: stage.id,
        type: "smoothstep",
        label: workflow.stages[index].loop ? "Otherwise" : undefined,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: workflow.stages[index].loop ? "#33846a" : "#b8b4cb",
        },
        labelStyle: { fill: "#286b56", fontWeight: 600, fontSize: 12 },
        labelBgPadding: [6, 4] as [number, number],
        labelBgBorderRadius: 4,
        style: {
          stroke: workflow.stages[index].loop ? "#33846a" : "#b8b4cb",
          strokeWidth: 1.5,
        },
        deletable: false,
      })),
      ...workflow.stages
        .filter((stage) => stage.loop)
        .map((stage) => ({
          id: `loop-${stage.id}`,
          source: stage.id,
          target: stage.loop!.targetStageId,
          sourceHandle: "loop-out",
          targetHandle: "loop-in",
          type: "smoothstep",
          label: `Repeat: back to ${workflow.stages.find((item) => item.id === stage.loop!.targetStageId)?.name}`,
          ariaLabel: `${stage.name}: if ${describeLoopCondition(stage.loop!)} repeat from ${stage.loop!.targetStageId}. Click to edit loop.`,
          markerEnd: { type: MarkerType.ArrowClosed, color: "#9b6b16" },
          pathOptions: { offset: 75, borderRadius: 16 },
          labelStyle: { fill: "#81520e", fontWeight: 600, fontSize: 12 },
          labelBgStyle: { fill: "#fffbf0", stroke: "#e9d7ad" },
          labelBgPadding: [10, 7] as [number, number],
          labelBgBorderRadius: 6,
          style: { stroke: "#9b6b16", strokeWidth: 2, strokeDasharray: "6 4" },
          deletable: false,
        })),
    ],
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
    if (mutationLocked.current || uploading) return;
    mutationLocked.current = true;
    setBusy(true);
    setError("");
    try {
      if (Object.values(invalid).some(Boolean))
        throw new Error("Fix the invalid fields before saving.");
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
      navigate(workflowPath(saved.value), { replace: true });
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
      navigate(collectionPath, { replace: true });
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
          to={collectionPath}
          className="icon-button"
          aria-label={actionItem ? "Back to actions" : "Back to workflows"}
        >
          <ArrowLeft size={18} />
        </Link>
        <div className="builder-title">
          <h1>{workflow.name}</h1>
          <span>
            {dirty ? "Unsaved changes" : "All changes saved"} ·{" "}
            {actionItem
              ? "Single-step action"
              : `${workflow.stages.length} stages`}
          </span>
        </div>
        <button
          className="button"
          disabled={busy || uploading}
          onClick={() => select({ kind: "workflow" })}
        >
          <Settings2 size={15} />
          Settings
        </button>
        <button
          className="icon-button"
          aria-label={actionItem ? "Duplicate action" : "Duplicate workflow"}
          disabled={busy || uploading}
          onClick={() => void save(true)}
        >
          <Copy size={16} />
        </button>
        {revision && !dirty && !uploading && (
          <Link className="button" to={`${workflowPath(workflow)}/run`}>
            <Play size={14} />
            Run
          </Link>
        )}
        {id && revision && (
          <button
            className="button danger"
            disabled={busy || uploading}
            onClick={() => void deleteWorkflow()}
          >
            <Trash2 size={14} />
            {deleting ? "Deleting…" : "Delete"}
          </button>
        )}
        <button
          className="button primary"
          disabled={busy || uploading}
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
        {actionItem ? (
          <ActionEditor
            workflow={workflow}
            update={update}
            disabled={busy || uploading}
            error={fieldError}
            uploading={setUploading}
          />
        ) : (
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
            {workflow.stages.some((stage) => stage.loop) && (
              <div className="canvas-loops" aria-label="Workflow loops">
                {workflow.stages.map(
                  (stage, index) =>
                    stage.loop && (
                      <button
                        key={stage.id}
                        className="canvas-loop-summary"
                        aria-label={`Edit loop: ${stage.name}`}
                        onClick={() =>
                          select({ kind: "stage", stageId: stage.id })
                        }
                      >
                        <strong>
                          <Repeat2 size={15} /> {stage.name} decision
                        </strong>
                        <span>If {describeLoopCondition(stage.loop)}</span>
                        <span>
                          Back to{" "}
                          <b>
                            {
                              workflow.stages.find(
                                (item) => item.id === stage.loop?.targetStageId,
                              )?.name
                            }
                          </b>{" "}
                          · up to {stage.loop.maxIterations} passes
                        </span>
                        <small>
                          Otherwise:{" "}
                          {workflow.stages[index + 1]
                            ? `continue to ${workflow.stages[index + 1].name}`
                            : "finish workflow"}
                        </small>
                      </button>
                    ),
                )}
              </div>
            )}
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
              onEdgeClick={(_event, edge) => {
                const stage = workflow.stages.find(
                  (item) => `loop-${item.id}` === edge.id,
                );
                if (stage) select({ kind: "stage", stageId: stage.id });
              }}
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
              <FitWorkflow />
            </ReactFlow>
            <div className="canvas-hint">
              Drag to arrange · Connect to reorder · Click an agent to configure
            </div>
          </div>
        )}
        {selection && (
          <Inspector
            workflow={workflow}
            selection={selection}
            skills={skills.data?.map((item) => item.value) || []}
            update={update}
            close={() => select()}
            blocked={Object.values(invalid).some(Boolean)}
            disabled={busy || uploading}
            addStage={
              actionItem
                ? () =>
                    update({
                      ...workflow,
                      stages: [...workflow.stages, newStage()],
                    })
                : undefined
            }
            error={fieldError}
          />
        )}
      </div>
    </div>
  );
}

function FitWorkflow() {
  const initialized = useNodesInitialized();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (initialized && width && height) void fitView({ padding: 0.2 });
  }, [initialized, width, height, fitView]);
  return null;
}
