import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Bot, GripVertical, Repeat2 } from "lucide-react";
import type { Stage } from "../../shared/contracts.ts";

export type StageNodeData = {
  stage: Stage;
  index: number;
  selectStage: () => void;
  selectAgent: (id: string) => void;
  selectedAgent?: string;
  loopTargetName?: string;
};
export type StageCanvasNode = Node<StageNodeData, "stage">;
export function StageNode({ data, selected }: NodeProps<StageCanvasNode>) {
  return (
    <div className={`stage-node ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <button className="stage-node-heading" onClick={data.selectStage}>
        <span className="step-number">
          {String(data.index + 1).padStart(2, "0")}
        </span>
        <strong>{data.stage.name}</strong>
        <GripVertical size={14} />
      </button>
      <div className="stage-agents">
        {data.stage.agents.map((agent) => (
          <button
            key={agent.id}
            className={`agent-card nodrag ${data.selectedAgent === agent.id ? "selected" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              data.selectAgent(agent.id);
            }}
          >
            <span className="agent-avatar">
              <Bot size={15} />
            </span>
            <span>
              <strong>{agent.name}</strong>
              <small>{agent.model || "Backend default"}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="stage-node-footer">
        {data.stage.skills.length} shared skills
        <span>
          {data.stage.agents.length} agent
          {data.stage.agents.length > 1 ? "s" : ""}
        </span>
      </div>
      {data.stage.loop && (
        <button
          className="stage-loop-badge nodrag"
          onClick={data.selectStage}
          aria-label={`Edit loop for ${data.stage.name}`}
        >
          <Repeat2 size={14} />
          <span>
            Back to <strong>{data.loopTargetName}</strong>
          </span>
          <small>Up to {data.stage.loop.maxIterations} passes</small>
        </button>
      )}
      <Handle type="source" position={Position.Right} />
      <Handle
        id="loop-out"
        className="loop-handle"
        type="source"
        position={Position.Bottom}
        style={{ left: "70%" }}
        isConnectable={false}
      />
      <Handle
        id="loop-in"
        className="loop-handle"
        type="target"
        position={Position.Bottom}
        style={{ left: "30%" }}
        isConnectable={false}
      />
    </div>
  );
}
