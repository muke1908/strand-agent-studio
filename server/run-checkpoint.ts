import { z } from "zod";
import {
  identifier,
  jsonValue,
  loopContextSchema,
  loopRouteSchema,
  schema,
} from "../shared/contracts.ts";
import type { Json } from "../shared/contracts.ts";
import { resolveStageInput } from "../shared/bindings.ts";
import { digest } from "./files.ts";
import type { RunStore } from "./run-store.ts";
import { assertStageNotBlocked } from "./validation.ts";

export const acceptedOutputSchema = z.object({
  runId: identifier,
  inputDigest: z.string(),
  stageId: identifier,
  agentId: identifier,
  output: jsonValue,
  visitId: identifier.optional(),
});
export const stageCheckpointSchema = z.object({
  stageId: identifier,
  contract: schema,
  outputs: z.record(z.string(), acceptedOutputSchema),
  loopContext: loopContextSchema.optional(),
});
export const outputArtifactName = (
  stageId: string,
  agentId: string,
  visitId?: string,
) =>
  `output-${digest({ stageId, agentId, ...(visitId ? { visitId } : {}) })}.json`;

export function checkpointPrefix(
  store: RunStore,
  runId: string,
  fromStageId: string,
): z.infer<typeof stageCheckpointSchema>[] {
  const snapshot = store.snapshot(runId);
  const run = store.get(runId);
  const index = snapshot.workflow.stages.findIndex(
    (stage) => stage.id === fromStageId,
  );
  if (index < 0)
    throw Object.assign(new Error("Stage not found in the pinned workflow"), {
      status: 400,
    });
  const handoffs: Record<string, Json> = {};
  return snapshot.workflow.stages.slice(0, index).map((stage) => {
    const visitId = run.units[`${stage.id}/${stage.agents[0].id}`]?.visitId;
    const loopContext = run.visits?.find(
      (visit) => visit.id === visitId,
    )?.loopContext;
    if (stage.loop) {
      const route = visitId
        ? store.readArtifactIfPresent(runId, `route-${visitId}.json`)
        : undefined;
      if (
        route === undefined ||
        !["continue", "skipped"].includes(loopRouteSchema.parse(route).kind)
      )
        throw Object.assign(
          new Error(
            `${stage.name}'s loop has not exited. Rerun from that stage or an earlier stage instead.`,
          ),
          { status: 409 },
        );
    }
    const raw = store.readArtifactIfPresent(runId, `schema-${stage.id}.json`);
    if (raw === undefined)
      throw Object.assign(
        new Error(
          `${stage.name} has no accepted contract. Rerun from an earlier stage.`,
        ),
        { status: 409 },
      );
    const contract = schema.parse(raw);
    const stageInput = resolveStageInput(
      snapshot.workflow,
      stage,
      snapshot.input,
      handoffs,
      loopContext,
    );
    const inputDigest = digest({
      input: snapshot.input,
      stageInput,
      handoffs,
      ...(loopContext ? { loopContext } : {}),
    });
    const outputs: z.infer<typeof stageCheckpointSchema>["outputs"] = {};
    for (const agent of stage.agents) {
      const raw = store.readArtifactIfPresent(
        runId,
        outputArtifactName(
          stage.id,
          agent.id,
          run.units[`${stage.id}/${agent.id}`]?.visitId,
        ),
      );
      if (raw === undefined)
        throw Object.assign(
          new Error(
            `${stage.name} / ${agent.name} has no accepted output. Rerun from an earlier stage.`,
          ),
          { status: 409 },
        );
      const saved = acceptedOutputSchema.parse(raw);
      if (
        saved.runId !== runId ||
        saved.stageId !== stage.id ||
        saved.agentId !== agent.id ||
        saved.inputDigest !== inputDigest
      )
        throw new Error("Accepted output identity mismatch");
      outputs[agent.id] = saved;
    }
    for (const [agentId, saved] of Object.entries(outputs))
      handoffs[`${stage.id}/${agentId}`] = saved.output;
    assertStageNotBlocked(stage, handoffs);
    return {
      stageId: stage.id,
      contract,
      outputs,
      ...(loopContext ? { loopContext } : {}),
    };
  });
}
