import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { jsonValue, schema } from "../shared/contracts.ts";
import type {
  Json,
  Schema,
  Stage,
  Agent,
  Attempt,
  Run,
} from "../shared/contracts.ts";
import { resolveReference } from "../shared/bindings.ts";
import { digest } from "./files.ts";
import type { AgentBackend } from "./agent-backend.ts";
import type { RunStore } from "./run-store.ts";
import { validateExpansion, validateJson } from "./validation.ts";
import { stagePrompt } from "./prompts.ts";
import { assertAttemptStopped } from "./process-runner.ts";

const envelope = z.object({
  runId: z.string(),
  inputDigest: z.string(),
  stageId: z.string(),
  agentId: z.string(),
  output: jsonValue,
});

export async function executeRun(
  store: RunStore,
  id: string,
  backend: AgentBackend,
  signal: AbortSignal,
): Promise<void> {
  const unlock = store.lease(id);
  const run = store.get(id);
  try {
    store.verify(id);
    const snapshot = store.snapshot(id);
    if (snapshot.backendId !== backend.id)
      throw new Error("Pinned backend is unavailable; refusing substitution");
    for (const unit of Object.values(run.units)) {
      for (const attempt of unit.attempts)
        assertAttemptStopped(
          path.join(store.directory(id), "attempts", attempt.id),
        );
    }
    for (const stage of snapshot.workflow.stages) {
      store.readArtifactIfPresent(id, `schema-${stage.id}.json`);
      for (const agent of stage.agents)
        store.readArtifactIfPresent(
          id,
          `output-${digest({ stageId: stage.id, agentId: agent.id })}.json`,
        );
    }
    store.readArtifactIfPresent(id, "output.json");
    store.readArtifactIfPresent(id, "result.json");
    const outputs: Record<string, Json> = {};
    run.status = "running";
    delete run.error;
    store.save(run);
    for (const stage of snapshot.workflow.stages) {
      signal.throwIfAborted();
      run.currentStage = stage.id;
      store.save(run);
      const stageInput = Object.fromEntries(
        Object.entries(stage.inputs).map(([name, ref]) => [
          name,
          resolveReference(ref, snapshot.input, outputs),
        ]),
      );
      const contract = await expandedSchema(stage);
      const settled = await Promise.allSettled(
        stage.agents.map((agent) =>
          unit(stage, agent, contract, stageInput, outputs),
        ),
      );
      const failures = settled.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          `${stage.name}: ${failures.length} agent(s) failed`,
        );
      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        if (result.status === "fulfilled")
          outputs[`${stage.id}/${stage.agents[index].id}`] = result.value;
      }
    }
    const finalStage = snapshot.workflow.stages.at(-1)!;
    const finalOutputs = finalStage.agents.map(
      (agent) => outputs[`${finalStage.id}/${agent.id}`],
    );
    const result = snapshot.workflow.result
      ? resolveReference(snapshot.workflow.result, snapshot.input, outputs)
      : finalOutputs;
    store.artifact(id, "output.json", finalOutputs);
    store.artifact(id, "result.json", result);
    run.result = result;
    run.status = "completed";
    delete run.error;
    store.save(run);

    async function expandedSchema(stage: Stage): Promise<Schema> {
      const name = `schema-${stage.id}.json`;
      const key = `@schema/${stage.id}`;
      const record = (run.units[key] ||= {
        stageId: stage.id,
        agentId: "schema",
        name: `${stage.name} contract`,
        status: "queued",
        attempts: [],
      });
      const saved = store.readArtifactIfPresent(id, name);
      if (saved !== undefined) {
        const contract = schema.parse(saved);
        completeRecoveredUnit(record);
        return contract;
      }
      const attempt: Attempt = {
        id: `schema-${stage.id}-${randomUUID()}`,
        status: "running",
      };
      record.attempts.push(attempt);
      record.status = "running";
      store.save(run);
      const directory = path.join(store.directory(id), "attempts", attempt.id);
      fs.mkdirSync(directory, { recursive: true });
      try {
        const output = await backend.execute(
          {
            directory,
            purpose: "schema",
            allowAllTools: snapshot.allowAllTools ?? false,
            allowedFolders: snapshot.allowedFolders ?? [],
            schema: { type: "object" },
            input: jsonValue.parse(stage.outputSchema),
            prompt: `Return a JSON Schema refining this authored stage contract for "${stage.name}". Preserve every authored constraint. Return the schema itself, not a wrapper. Base:\n${JSON.stringify(stage.outputSchema)}`,
          },
          signal,
        );
        signal.throwIfAborted();
        const expanded = schema.parse(output);
        validateExpansion(stage.outputSchema, expanded);
        store.artifact(id, name, expanded);
        record.status = "completed";
        attempt.status = "completed";
        store.save(run);
        return expanded;
      } catch (error) {
        record.status = signal.aborted ? "cancelled" : "blocked";
        attempt.status = record.status;
        attempt.error = error instanceof Error ? error.message : String(error);
        store.save(run);
        throw error;
      }
    }
    function completeRecoveredUnit(
      record: Run["units"][string],
      output?: Json,
    ): void {
      record.status = "completed";
      const attempt = record.attempts.at(-1);
      if (attempt?.status === "running") {
        attempt.status = "completed";
        delete attempt.error;
        if (output !== undefined) attempt.output = output;
      }
      store.save(run);
    }
    async function unit(
      stage: Stage,
      agent: Agent,
      contract: Schema,
      stageInput: Json,
      handoffs: Record<string, Json>,
    ): Promise<Json> {
      const key = `${stage.id}/${agent.id}`;
      const artifactName = `output-${digest({ stageId: stage.id, agentId: agent.id })}.json`;
      const inputDigest = digest({
        input: snapshot.input,
        stageInput,
        handoffs,
      });
      const record = (run.units[key] ||= {
        stageId: stage.id,
        agentId: agent.id,
        name: agent.name,
        status: "queued",
        attempts: [],
      });
      const accepted = store.readArtifactIfPresent(id, artifactName);
      if (accepted !== undefined) {
        const saved = envelope.parse(accepted);
        if (
          saved.runId !== id ||
          saved.inputDigest !== inputDigest ||
          saved.stageId !== stage.id ||
          saved.agentId !== agent.id
        )
          throw new Error("Accepted output identity mismatch");
        validateJson(contract, saved.output);
        record.output = saved.output;
        completeRecoveredUnit(record, saved.output);
        return saved.output;
      }
      const attempt: Attempt = {
        id: `${stage.id}-${agent.id}-${randomUUID()}`,
        status: "running",
      };
      record.attempts.push(attempt);
      record.status = "running";
      store.save(run);
      const directory = path.join(store.directory(id), "attempts", attempt.id);
      fs.mkdirSync(directory, { recursive: true });
      try {
        const output = await backend.execute(
          {
            directory,
            schema: contract,
            purpose: "stage",
            allowAllTools: snapshot.allowAllTools ?? false,
            allowedFolders:
              agent.allowedFolders ?? snapshot.allowedFolders ?? [],
            input: stageInput,
            model: agent.model,
            prompt: stagePrompt(
              stage,
              agent,
              snapshot.skills,
              snapshot.input,
              stageInput,
              handoffs,
            ),
          },
          signal,
        );
        signal.throwIfAborted();
        validateJson(contract, output);
        store.artifact(id, artifactName, {
          runId: id,
          inputDigest,
          stageId: stage.id,
          agentId: agent.id,
          output,
        });
        record.output = output;
        record.status = "completed";
        Object.assign(attempt, { status: "completed", output });
        store.save(run);
        return output;
      } catch (error) {
        record.status = signal.aborted ? "cancelled" : "blocked";
        const text = error instanceof Error ? error.message : String(error);
        Object.assign(attempt, { status: record.status, error: text });
        store.save(run);
        throw error;
      }
    }
  } catch (error) {
    run.status = signal.aborted ? "cancelled" : "blocked";
    run.error = describeError(error);
    store.save(run);
  } finally {
    unlock();
  }
}

function describeError(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map(describeError).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}
