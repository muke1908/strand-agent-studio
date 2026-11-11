import fs from "node:fs";
import { z } from "zod";
import { jsonValue } from "../shared/contracts.ts";
import type {
  Decision,
  Json,
  Run,
  Watch,
  WatchState,
} from "../shared/contracts.ts";
import {
  pointer,
  resolveReference,
  validatePointer,
} from "../shared/bindings.ts";
import { claim, digest, itemPath, readJson, writeJson } from "./files.ts";
import { validateJson } from "./validation.ts";
import type { Catalog } from "./catalog.ts";
import type { RunHost } from "./run-host.ts";
import { WorkflowBusyError } from "./run-host.ts";
import type { WatchPolicy } from "./watch-policies.ts";
import { compareValues } from "./conditions.ts";
import { readWatchSchedule } from "../shared/watch-schedule.ts";

const stateSchema: z.ZodType<WatchState> = z.object({
  id: z.string(),
  cursor: jsonValue.optional(),
  nextCheck: z.string(),
  lastChecked: z.string().optional(),
  error: z.string().optional(),
  phase: z.enum(["watching", "checking", "acting", "waiting"]).optional(),
  activeRunId: z.string().optional(),
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
      outcome: z
        .enum([
          "skipped",
          "duplicate",
          "completed",
          "blocked",
          "cancelled",
          "error",
        ])
        .optional(),
      outcomeReason: z.string().optional(),
      action: z
        .object({
          requestId: z.string(),
          input: jsonValue,
          key: z.string().optional(),
          runId: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

function canonicalRevision(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalRevision);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalRevision(value[key])]),
    );
  return value;
}

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
  function validateConfiguration(watch: Watch): void {
    const policy = policies.find((item) => item.id === watch.policyId);
    if (!policy) throw new Error("Unknown watcher policy");
    validateJson(policy.settingsSchema, watch.settings);
    if (watch.policyId === "schedule-cron") readWatchSchedule(watch.settings);
    const workflow = catalog.workflow(watch.workflowId).value;
    if (watch.input !== undefined) {
      if (Object.keys(watch.inputBindings).length)
        throw new Error("Provide either input or input bindings, not both");
      if (typeof watch.input !== "string")
        validateJson(workflow.inputSchema, watch.input);
    }
    for (const ref of Object.values(watch.inputBindings)) {
      if (ref.source !== "literal" && ref.source !== "trigger")
        throw new Error("Watch inputs must use trigger fields or literals");
      if (ref.source !== "literal") validatePointer(ref.pointer);
    }
    if (watch.action) {
      catalog.workflow(watch.action.workflowId);
      if (watch.action.input && Object.keys(watch.action.inputBindings).length)
        throw new Error(
          "Provide either action input or input bindings, not both",
        );
      for (const ref of [
        ...(watch.action.input ? [watch.action.input] : []),
        ...Object.values(watch.action.inputBindings),
      ]) {
        if (!["literal", "input", "trigger"].includes(ref.source))
          throw new Error(
            "Action inputs must use literals, check input or check result",
          );
        if (ref.source !== "literal") validatePointer(ref.pointer);
      }
      if (watch.action.deduplicationPointer !== undefined)
        validatePointer(watch.action.deduplicationPointer);
      for (const condition of watch.action.conditions) {
        validatePointer(condition.pointer);
        if (
          !["equals", "notEquals"].includes(condition.operator) &&
          (typeof condition.value !== "number" ||
            (condition.operator === "olderThanSeconds" && condition.value < 0))
        )
          throw new Error(
            "Numeric and age conditions need a numeric value; ages must be nonnegative",
          );
      }
    }
  }
  function validate(watch: Watch): void {
    try {
      validateConfiguration(watch);
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { status: 400 },
      );
    }
  }
  function save(current: WatchState): void {
    writeJson(itemPath(root, "watch-state", current.id), current);
  }
  function checkRequestId(watch: Watch, decision: Decision): string {
    return `watch-${digest({ watchId: watch.id, eventId: decision.eventId, resource: decision.resourceId })}`;
  }
  function wait(
    current: WatchState,
    run: Run,
    phase: WatchState["phase"],
    now: Date,
  ): void {
    current.phase = phase;
    current.activeRunId = run.id;
    current.nextCheck = new Date(now.getTime() + 5000).toISOString();
    save(current);
  }
  function finish(
    watch: Watch,
    current: WatchState,
    now: Date,
    error?: string,
  ): void {
    current.phase = "watching";
    delete current.activeRunId;
    if (error) current.error = error;
    else delete current.error;
    current.nextCheck = new Date(
      now.getTime() + watch.action!.recheckSeconds * 1000,
    ).toISOString();
    save(current);
  }
  function matches(
    result: Json,
    condition: NonNullable<Watch["action"]>["conditions"][number],
    now: Date,
  ): boolean {
    const actual = pointer(result, condition.pointer);
    if (
      condition.value === null &&
      ["equals", "notEquals"].includes(condition.operator)
    )
      return condition.operator === "equals"
        ? actual === null
        : actual !== null;
    if (condition.operator !== "olderThanSeconds")
      return compareValues(
        actual,
        condition.operator,
        condition.value,
        `Watch condition ${condition.pointer}`,
      );
    const timestamp = z.string().datetime({ offset: true }).parse(actual);
    const age = now.getTime() - Date.parse(timestamp);
    if (!Number.isFinite(age) || age < 0)
      throw new Error(
        "Watch age condition requires a valid, non-future timestamp",
      );
    if (typeof condition.value !== "number")
      throw new Error("Watch age condition requires seconds");
    return age > condition.value * 1000;
  }
  function withinBudget(watch: Watch, now: Date): boolean {
    const recent = host.store
      .list()
      .filter(
        (run) =>
          run.trigger?.watchId === watch.id &&
          run.trigger.role === "action" &&
          now.getTime() - Date.parse(run.createdAt) < 3600000,
      );
    return (
      recent.length < watch.maxRunsPerHour &&
      !recent.some(
        (run) =>
          now.getTime() - Date.parse(run.createdAt) <
          watch.cooldownSeconds * 1000,
      )
    );
  }
  function cycle(watch: Watch, current: WatchState, now: Date): boolean {
    const action = watch.action!;
    const runs = host.store.list();
    // Reconcile launches committed before a crash interrupted the watch-state write.
    for (const decision of current.decisions.filter(
      (item) => item.status === "pending",
    )) {
      const run = runs.find(
        (item) => item.requestId === checkRequestId(watch, decision),
      );
      if (run) {
        decision.status = "launched";
        decision.runId = run.id;
      } else decision.status = "superseded";
    }
    const decision = current.decisions.findLast(
      (item) => item.status === "launched" && !item.outcome,
    );
    if (decision) {
      const check = host.store.get(decision.runId!);
      const launched =
        decision.action &&
        runs.find((run) => run.requestId === decision.action!.requestId);
      if (launched) {
        decision.action!.runId = launched.id;
        if (
          host.busy(launched.workflowId)?.id === launched.id ||
          ["queued", "running"].includes(launched.status)
        ) {
          wait(current, launched, "acting", now);
        } else {
          decision.outcome =
            launched.status === "completed"
              ? "completed"
              : launched.status === "cancelled"
                ? "cancelled"
                : "blocked";
          decision.error = launched.error;
          finish(
            watch,
            current,
            now,
            launched.status === "completed"
              ? undefined
              : launched.error ||
                  `Action ${launched.status}; a fresh check will retry`,
          );
        }
        return true;
      }
      if (
        ["queued", "running"].includes(check.status) ||
        host.busy(check.workflowId)?.id === check.id
      ) {
        wait(current, check, "checking", now);
        return true;
      }
      if (check.status !== "completed") {
        decision.outcome =
          check.status === "cancelled" ? "cancelled" : "blocked";
        decision.error = check.error;
        finish(
          watch,
          current,
          now,
          check.error || `Check ${check.status}; will retry`,
        );
        return true;
      }
      const busy = host.busy(action.workflowId);
      if (busy) {
        decision.outcome = "skipped";
        decision.outcomeReason =
          "Target became busy; discard this check and fetch fresh input after it finishes.";
        wait(current, busy, "waiting", now);
        return true;
      }
      if (
        now.getTime() - Date.parse(check.updatedAt) >
        action.recheckSeconds * 1000
      ) {
        decision.outcome = "skipped";
        decision.outcomeReason = "Check expired; a fresh check is required.";
        finish(watch, current, now);
        return true;
      }
      const result = jsonValue.parse(
        host.store.readArtifact(check.id, "result.json"),
      );
      if (
        !action.conditions.every((condition) => matches(result, condition, now))
      ) {
        decision.outcome = "skipped";
        decision.outcomeReason = "Check result did not meet all conditions.";
        finish(watch, current, now);
        return true;
      }
      if (!decision.action) {
        const key =
          action.deduplicationPointer === undefined
            ? undefined
            : digest({
                resourceId: decision.resourceId,
                revision: canonicalRevision(
                  pointer(result, action.deduplicationPointer),
                ),
              });
        if (
          key &&
          current.decisions.some(
            (item) =>
              item.action?.key === key &&
              runs.some(
                (run) =>
                  run.requestId === item.action!.requestId &&
                  run.status === "completed",
              ),
          )
        ) {
          decision.outcome = "duplicate";
          decision.outcomeReason =
            "This resource revision was already handled successfully.";
          finish(watch, current, now);
          return true;
        }
        const input = action.input
          ? resolveReference(
              action.input,
              host.store.snapshot(check.id).input,
              {},
              result,
            )
          : Object.fromEntries(
              Object.entries(action.inputBindings).map(([name, ref]) => [
                name,
                resolveReference(
                  ref,
                  host.store.snapshot(check.id).input,
                  {},
                  result,
                ),
              ]),
            );
        if (typeof input !== "string")
          validateJson(
            catalog.workflow(action.workflowId).value.inputSchema,
            input,
          );
        decision.action = {
          requestId: `watch-action-${digest({ watchId: watch.id, checkRunId: check.id })}`,
          input,
          ...(key ? { key } : {}),
        };
        save(current);
      }
      if (!withinBudget(watch, now)) {
        decision.outcome = "skipped";
        decision.outcomeReason =
          "Action cooldown or hourly limit reached; retry with a fresh check.";
        finish(watch, current, now);
        return true;
      }
      try {
        const run = host.launch(
          action.workflowId,
          decision.action.input,
          decision.action.requestId,
          {
            watchId: watch.id,
            eventId: decision.eventId,
            reason: `Qualified check ${check.id}: ${decision.reason}`,
            role: "action",
          },
          watch.allowAllTools ?? false,
          [watch.workflowId, action.workflowId],
        );
        decision.action.runId = run.id;
        wait(current, run, "acting", now);
      } catch (error) {
        if (!(error instanceof WorkflowBusyError)) throw error;
        decision.outcome = "skipped";
        decision.outcomeReason =
          "Target became busy during admission; a fresh check is required.";
        wait(current, host.store.get(error.runId), "waiting", now);
      }
      return true;
    }
    if (current.phase === "waiting" && current.activeRunId) {
      const run = host.store.get(current.activeRunId);
      if (
        ["queued", "running"].includes(run.status) ||
        host.busy(run.workflowId)?.id === run.id
      )
        wait(current, run, "waiting", now);
      else finish(watch, current, now);
      return true;
    }
    const busy = host.busy(action.workflowId) ?? host.busy(watch.workflowId);
    if (busy) {
      wait(current, busy, "waiting", now);
      return true;
    }
    return false;
  }
  async function evaluate(watch: Watch, now = new Date()): Promise<WatchState> {
    const release = claim(itemPath(root, "watch-claims", watch.id));
    try {
      watch = catalog.watch(watch.id).value;
      const current = state(watch.id);
      const file = itemPath(root, "watch-state", watch.id);
      if (!watch.enabled) return current;
      try {
        validate(watch);
        if (watch.action && cycle(watch, current, now)) return current;
        const policy = policies.find((item) => item.id === watch.policyId)!;
        const observation = await policy.evaluate(
          watch.settings,
          current.cursor,
          now,
        );
        for (const candidate of watch.action
          ? observation.candidates.slice(-1)
          : observation.candidates) {
          if (
            current.decisions.some(
              (item) =>
                item.eventId === candidate.eventId &&
                item.resourceId === candidate.resourceId,
            )
          )
            continue;
          const input =
            watch.input !== undefined
              ? watch.input
              : Object.fromEntries(
                  Object.entries(watch.inputBindings).map(([key, ref]) => [
                    key,
                    resolveReference(ref, null, {}, candidate.payload),
                  ]),
                );
          if (typeof input !== "string")
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
        if (watch.action) current.phase = "watching";
        delete current.error;
        writeJson(file, current);
        dispatch(watch.id, current, now);
      } catch (error) {
        current.error = error instanceof Error ? error.message : String(error);
        if (watch.action) {
          const decision = current.decisions.findLast(
            (item) => item.status === "launched" && !item.outcome,
          );
          if (decision) {
            decision.outcome = "error";
            decision.error = current.error;
          }
          finish(watch, current, now, current.error);
        } else {
          current.nextCheck = new Date(now.getTime() + 120000).toISOString();
          writeJson(file, current);
        }
      }
      return current;
    } finally {
      release();
    }
  }
  function dispatch(id: string, current: WatchState, now: Date) {
    const watch = catalog.watch(id).value;
    const runs = host.store.list();
    const latest = current.decisions.filter(
      (item) => item.status === "pending",
    );
    for (const decision of latest) {
      const requestId = checkRequestId(watch, decision);
      const already = runs.find((run) => run.requestId === requestId);
      if (already) {
        decision.status = "launched";
        decision.runId = already.id;
        continue;
      }
      if (!watch.enabled) continue;
      if (watch.action) {
        const busy =
          host.busy(watch.workflowId) ?? host.busy(watch.action.workflowId);
        if (busy) {
          decision.status = "superseded";
          wait(current, busy, "waiting", now);
          continue;
        }
      }
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
          (!watch.action || run.trigger.role === "check") &&
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
        const run = host.launch(
          watch.workflowId,
          decision.input,
          requestId,
          {
            watchId: watch.id,
            eventId: decision.eventId,
            reason: decision.reason,
            ...(watch.action ? { role: "check" } : {}),
          },
          watch.allowAllTools ?? false,
          watch.action ? [watch.workflowId, watch.action.workflowId] : [],
        );
        decision.status = "launched";
        decision.runId = run.id;
        runs.push(run);
        if (watch.action) {
          wait(current, run, "checking", now);
          break;
        }
      } catch (error) {
        if (watch.action && error instanceof WorkflowBusyError) {
          decision.status = "superseded";
          wait(current, host.store.get(error.runId), "waiting", now);
          continue;
        }
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
            fs.existsSync(itemPath(root, "watches", watch.id)) &&
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
