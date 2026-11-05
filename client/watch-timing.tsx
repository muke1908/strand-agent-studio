import { CronExpressionParser } from "cron-parser";
import { Link } from "react-router-dom";
import type { Decision, Watch, WatchState } from "../shared/contracts.ts";
import { errorMessage } from "./api.ts";
import { ErrorNotice } from "./components.tsx";

function readableTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function scheduleDescription(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length === 5 && fields.slice(1).every((field) => field === "*")) {
    const minute = fields[0];
    if (minute === "*") return "Every minute";
    if (minute === "0") return "Every hour, on the hour";
    if (/^\d+$/.test(minute)) return `Every hour, at minute ${minute}`;
    const step = minute.match(/^\*\/(\d+)$/);
    if (step && Number(step[1]) > 0 && 60 % Number(step[1]) === 0)
      return `Every ${Number(step[1])} minutes`;
  }
  return "Cron schedule";
}

function readSchedule(watch: Watch) {
  const { expression, timeZone = "UTC" } = watch.settings;
  if (typeof expression !== "string" || typeof timeZone !== "string")
    throw new Error("Cron expression and time zone must be strings.");
  const cron = CronExpressionParser.parse(expression, {
    tz: timeZone,
    currentDate: new Date(),
  });
  const next = cron.next().toISOString();
  if (next === null) throw new Error("No upcoming cron occurrence available.");
  return {
    expression,
    timeZone,
    description: scheduleDescription(expression),
    next,
  };
}

export function WatchTiming({
  watch,
  state,
}: {
  watch: Watch;
  state: WatchState;
}) {
  let schedule: ReturnType<typeof readSchedule> | undefined;
  let scheduleError = "";
  if (watch.policyId === "schedule-cron") {
    try {
      schedule = readSchedule(watch);
    } catch (failure) {
      scheduleError = `Invalid schedule: ${errorMessage(failure)}`;
    }
  }
  const suspended = state.activeRunId && state.phase !== "watching";
  const nextCheck =
    Date.parse(state.nextCheck) === 0
      ? "Establishing baseline"
      : readableTime(state.nextCheck);
  return (
    <div className="watch-meta watch-timing">
      <ErrorNotice error={scheduleError} />
      {schedule && (
        <p>
          Schedule: {schedule.description} ({schedule.timeZone})
        </p>
      )}
      {suspended ? (
        <p>
          Checks suspended.{" "}
          <Link to={`/runs/${state.activeRunId}`}>Open active run</Link>
        </p>
      ) : (
        watch.enabled &&
        (schedule ? (
          <p className="watch-next-run">
            Next scheduled {watch.action ? "check" : "run"}:{" "}
            <time dateTime={schedule.next}>{readableTime(schedule.next)}</time>
          </p>
        ) : (
          !scheduleError && <p>Next policy check: {nextCheck}</p>
        ))
      )}
      {schedule && (
        <details className="watch-schedule-details">
          <summary>Scheduler details</summary>
          <p>
            Cron: <code>{schedule.expression}</code> ({schedule.timeZone})
          </p>
          {!watch.enabled ? (
            <p>Paused. No automatic runs.</p>
          ) : (
            !suspended && <p>Next scheduler check: {nextCheck}</p>
          )}
          <p>
            The scheduler checks about once a minute, not a workflow run every
            minute. Scheduled runs may wait while a workflow is busy.
          </p>
          <p>Times are shown in your local time zone.</p>
        </details>
      )}
    </div>
  );
}

export function WatchDecisionReason({
  watch,
  decision,
}: {
  watch: Watch;
  decision: Decision;
}) {
  if (
    watch.policyId === "schedule-cron" &&
    decision.resourceId === "schedule" &&
    decision.reason === `Scheduled for ${decision.eventId}` &&
    Number.isFinite(Date.parse(decision.eventId))
  ) {
    return (
      <>
        Scheduled time:{" "}
        <time dateTime={decision.eventId}>
          {readableTime(decision.eventId)}
        </time>
      </>
    );
  }
  return <>{decision.reason}</>;
}
