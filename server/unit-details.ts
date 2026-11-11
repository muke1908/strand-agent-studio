import { z } from "zod";
import { jsonValue, loopContextSchema } from "../shared/contracts.ts";
import type { Json, UnitDetails } from "../shared/contracts.ts";
import { resolveStageInput } from "../shared/bindings.ts";
import { outputArtifactName } from "./run-checkpoint.ts";
import type { RunStore } from "./run-store.ts";
import { agentSkills, stageSkipPolicy } from "./prompts.ts";

export function unitDetails(
  store: RunStore,
  id: string,
  key: string,
): UnitDetails {
  const run = store.get(id);
  const separator = key.indexOf(":");
  const historical =
    separator < 0
      ? undefined
      : run.visits?.find((visit) => visit.id === key.slice(0, separator));
  const logicalKey = separator < 0 ? key : key.slice(separator + 1);
  const records = historical?.units ?? (separator < 0 ? run.units : {});
  const unit = Object.hasOwn(records, logicalKey)
    ? records[logicalKey]
    : undefined;
  if (!unit)
    throw Object.assign(new Error("Activity not found"), { status: 404 });
  store.verify(id);
  const snapshot = store.snapshot(id);
  const stageIndex = snapshot.workflow.stages.findIndex(
    (stage) => stage.id === unit.stageId,
  );
  const stage = snapshot.workflow.stages[stageIndex];
  if (!stage)
    throw new Error("Activity stage is missing from the pinned workflow");
  if (logicalKey === `@schema/${stage.id}`) {
    const output = store.readArtifactIfPresent(id, `schema-${stage.id}.json`);
    return {
      unit,
      kind: "contract",
      input: stage.expectedOutput ?? jsonValue.parse(stage.outputSchema),
      ...(output === undefined ? {} : { output: jsonValue.parse(output) }),
    };
  }
  const agent = stage.agents.find(
    (agent) =>
      logicalKey === `${stage.id}/${agent.id}` && agent.id === unit.agentId,
  );
  if (!agent)
    throw new Error("Activity agent does not match the pinned workflow");
  if (unit.visitId) {
    const savedInput = z
      .object({
        stageInput: jsonValue,
        handoffs: jsonValue,
        loopContext: loopContextSchema.nullable(),
      })
      .parse(store.readArtifact(id, `input-${unit.visitId}.json`));
    const saved = store.readArtifactIfPresent(
      id,
      outputArtifactName(stage.id, unit.agentId, unit.visitId),
    );
    return {
      unit,
      kind: "agent",
      input: {
        agentInstructions: agent.instructions,
        allowedFolders: agent.allowedFolders ?? snapshot.allowedFolders ?? [],
        ...(snapshot.paths ? { paths: snapshot.paths } : {}),
        skills: agentSkills(stage, agent, snapshot.skills),
        workflowInput: snapshot.input,
        ...savedInput,
        ...(snapshot.stageSkips?.length
          ? { ownerOverridePolicy: stageSkipPolicy(snapshot.stageSkips) }
          : {}),
      },
      ...(saved === undefined
        ? {}
        : { output: z.object({ output: jsonValue }).parse(saved).output }),
    };
  }
  const handoffs: Record<string, Json> = {};
  for (const previous of snapshot.workflow.stages.slice(0, stageIndex)) {
    for (const agent of previous.agents) {
      const saved = z
        .object({ output: jsonValue })
        .parse(
          store.readArtifact(id, outputArtifactName(previous.id, agent.id)),
        );
      handoffs[`${previous.id}/${agent.id}`] = saved.output;
    }
  }
  const stageInput = resolveStageInput(
    snapshot.workflow,
    stage,
    snapshot.input,
    handoffs,
  );
  const saved = store.readArtifactIfPresent(
    id,
    outputArtifactName(stage.id, unit.agentId),
  );
  return {
    unit,
    kind: "agent",
    input: {
      agentInstructions: agent.instructions,
      allowedFolders: agent.allowedFolders ?? snapshot.allowedFolders ?? [],
      ...(snapshot.paths ? { paths: snapshot.paths } : {}),
      skills: agentSkills(stage, agent, snapshot.skills),
      workflowInput: snapshot.input,
      stageInput,
      handoffs,
      ...(snapshot.stageSkips?.length
        ? { ownerOverridePolicy: stageSkipPolicy(snapshot.stageSkips) }
        : {}),
    },
    ...(saved === undefined
      ? {}
      : { output: z.object({ output: jsonValue }).parse(saved).output }),
  };
}
