import { z } from "zod";
import { jsonValue } from "../shared/contracts.ts";
import type { Json, UnitDetails } from "../shared/contracts.ts";
import { resolveReference } from "../shared/bindings.ts";
import { digest } from "./files.ts";
import type { RunStore } from "./run-store.ts";
import { agentSkills } from "./prompts.ts";

export function unitDetails(
  store: RunStore,
  id: string,
  key: string,
): UnitDetails {
  const run = store.get(id);
  const unit = Object.hasOwn(run.units, key) ? run.units[key] : undefined;
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
  if (key === `@schema/${stage.id}`) {
    const output = store.readArtifactIfPresent(id, `schema-${stage.id}.json`);
    return {
      unit,
      kind: "contract",
      input: jsonValue.parse(stage.outputSchema),
      ...(output === undefined ? {} : { output: jsonValue.parse(output) }),
    };
  }
  const agent = stage.agents.find(
    (agent) => key === `${stage.id}/${agent.id}` && agent.id === unit.agentId,
  );
  if (!agent)
    throw new Error("Activity agent does not match the pinned workflow");
  const handoffs: Record<string, Json> = {};
  for (const previous of snapshot.workflow.stages.slice(0, stageIndex)) {
    for (const agent of previous.agents) {
      const saved = z
        .object({ output: jsonValue })
        .parse(
          store.readArtifact(
            id,
            `output-${digest({ stageId: previous.id, agentId: agent.id })}.json`,
          ),
        );
      handoffs[`${previous.id}/${agent.id}`] = saved.output;
    }
  }
  const stageInput = Object.fromEntries(
    Object.entries(stage.inputs).map(([name, ref]) => [
      name,
      resolveReference(ref, snapshot.input, handoffs),
    ]),
  );
  const saved = store.readArtifactIfPresent(
    id,
    `output-${digest({ stageId: stage.id, agentId: unit.agentId })}.json`,
  );
  return {
    unit,
    kind: "agent",
    input: {
      stageInstructions: stage.instructions,
      agentInstructions: agent.instructions,
      allowedFolders: agent.allowedFolders ?? snapshot.allowedFolders ?? [],
      skills: agentSkills(stage, agent, snapshot.skills),
      workflowInput: snapshot.input,
      stageInput,
      handoffs,
    },
    ...(saved === undefined
      ? {}
      : { output: z.object({ output: jsonValue }).parse(saved).output }),
  };
}
