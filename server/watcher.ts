import fs from "node:fs";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { jsonValue } from "../shared/contracts.ts";
import type { Watch, WatchState } from "../shared/contracts.ts";
import { resolveReference } from "../shared/bindings.ts";
import { claim, digest, itemPath, readJson, writeJson } from "./files.ts";
import { validateJson } from "./validation.ts";
import type { Catalog } from "./catalog.ts";
import type { RunHost } from "./run-host.ts";
import type { WatchPolicy } from "./watch-policies.ts";

const stateSchema: z.ZodType<WatchState> = z.object({
  id: z.string(),
  cursor: jsonValue.optional(),
  nextCheck: z.string(),
  lastChecked: z.string().optional(),
  error: z.string().optional(),
  decisions: z.array(
    z.object({
      eventId: z.string(),
      resourceId: z.string(),
      reason: z.string(),
      input: jsonValue,
      observedAt: z.string(),
      status: z.enum(["pending", "launched", "superseded", "rejected"]),
      runId: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

export function createWatcher(
  root: string,
  catalog: Catalog,
  host: RunHost,
  policies: WatchPolicy[],
) {
  function state(id: string): WatchState {
    const file = itemPath(root, "watch-state", id);
    return fs.existsSync(file)
      ? stateSchema.parse(readJson(file))
      : { id, nextCheck: new Date(0).toISOString(), decisions: [] };
  }
  function validate(watch: Watch): void {
    const policy = policies.find((item) => item.id === watch.policyId);
    if (!policy) throw new Error("Unknown watcher policy");
    validateJson(policy.settingsSchema, watch.settings);
    if (watch.policyId === "schedule-cron") {
      const expression = watch.settings.expression;
      const zone = watch.settings.timeZone;
      if (typeof expression !== "string" || typeof zone !== "string")
        throw new Error("Cron expression and time zone are required");
      new Intl.DateTimeFormat("en", { timeZone: zone });
      CronExpressionParser.parse(expression, { tz: zone });
    }
    catalog.workflow(watch.workflowId);
    for (const ref of Object.values(watch.inputBindings)) {
      if (ref.source !== "literal" && ref.source !== "trigger")
        throw new Error("Watch inputs must use trigger fields or literals");
    }
  }
  async function evaluate(watch: Watch, now = new Date()): Promise<WatchState> {
    if (!watch.enabled) return state(watch.id);
    const release = claim(itemPath(root, "watch-claims", watch.id));
    const current = state(watch.id);
    const file = itemPath(root, "watch-state", watch.id);
    try {
      validate(watch);
      const policy = policies.find((item) => item.id === watch.policyId)!;
      const observation = await policy.evaluate(
        watch.settings,
        current.cursor,
        now,
      );
      for (const candidate of observation.candidates) {
        if (
          current.decisions.some(
            (item) =>
              item.eventId === candidate.eventId &&
              item.resourceId === candidate.resourceId,
          )
        )
          continue;
        const input = Object.fromEntries(
          Object.entries(watch.inputBindings).map(([key, ref]) => [
            key,
            resolveReference(ref, null, {}, candidate.payload),
          ]),
        );
        validateJson(
          catalog.workflow(watch.workflowId).value.inputSchema,
          input,
        );
        for (const old of current.decisions.filter(
          (item) =>
            item.status === "pending" &&
            item.resourceId === candidate.resourceId,
        ))
          old.status = "superseded";
        current.decisions.push({
          eventId: candidate.eventId,
          resourceId: candidate.resourceId,
          reason: candidate.reason,
          input,
          observedAt: now.toISOString(),
          status: "pending",
        });
      }
      current.cursor = observation.cursor;
      current.lastChecked = now.toISOString();
      current.nextCheck = new Date(now.getTime() + 60000).toISOString();
      delete current.error;
      writeJson(file, current);
      dispatch(watch.id, current, now);
    } catch (error) {
      current.error = error instanceof Error ? error.message : String(error);
      current.nextCheck = new Date(now.getTime() + 120000).toISOString();
      writeJson(file, current);
    } finally {
      release();
    }
    return current;
  }
  function dispatch(id: string, current: WatchState, now: Date) {
    const watch = catalog.watch(id).value;
    const runs = host.store.list();
    const latest = current.decisions.filter(
      (item) => item.status === "pending",
    );
    for (const decision of latest) {
      const requestId = `watch-${digest({ watchId: watch.id, eventId: decision.eventId, resource: decision.resourceId })}`;
      const already = runs.find((run) => run.requestId === requestId);
      if (already) {
        decision.status = "launched";
        decision.runId = already.id;
        continue;
      }
      if (!watch.enabled) continue;
      if (
        runs.some(
          (run) =>
            run.workflowId === watch.workflowId &&
            ["queued", "running"].includes(run.status),
        )
      )
        continue;
      const recent = runs.filter(
        (run) =>
          run.trigger?.watchId === watch.id &&
          now.getTime() - Date.parse(run.createdAt) < 3600000,
      );
      if (
        recent.length >= watch.maxRunsPerHour ||
        recent.some(
          (run) =>
            now.getTime() - Date.parse(run.createdAt) <
            watch.cooldownSeconds * 1000,
        )
      )
        continue;
      try {
        const run = host.launch(watch.workflowId, decision.input, requestId, {
          watchId: watch.id,
          eventId: decision.eventId,
          reason: decision.reason,
        });
        decision.status = "launched";
        decision.runId = run.id;
        runs.push(run);
      } catch (error) {
        decision.error = error instanceof Error ? error.message : String(error);
        current.error = decision.error;
      }
    }
    writeJson(itemPath(root, "watch-state", watch.id), current);
  }
  let ticking = false;
  return {
    state,
    validate,
    evaluate,
    policies,
    async tick(now = new Date()) {
      if (ticking) return;
      ticking = true;
      try {
        for (const { value: watch } of catalog.watches()) {
          if (
            watch.enabled &&
            Date.parse(state(watch.id).nextCheck) <= now.getTime()
          )
            await evaluate(watch, now);
        }
      } finally {
        ticking = false;
      }
    },
  };
}
export type Watcher = ReturnType<typeof createWatcher>;
