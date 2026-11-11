import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { Json } from "./contracts.ts";

export const watchSchedulePlanSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    expressions: z.array(z.string().trim().min(1).max(200)).max(20),
    intervalMinutes: z.number().int().positive().nullable(),
  })
  .strict();
export const compiledWatchScheduleSchema = watchSchedulePlanSchema.extend({
  schedule: z.string().min(1).max(2000),
  timeZone: z.string().min(1).max(200),
});

const days = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const scheduleHelp =
  'Use a schedule like "every 15 min", "every day at 7am", or "every Monday at 9am".';

type Schedule =
  | { milliseconds: number; description: string }
  | { expressions: string[]; description: string };

function parseLegacySchedule(text: string): Schedule {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const interval = normalized.match(
    /^every (?:(\d+) )?(minute|minutes|min|mins|hour|hours|hr|hrs)$/,
  );
  if (interval) {
    const count = Number(interval[1] ?? 1);
    const unit = interval[2].startsWith("m") ? "minute" : "hour";
    const milliseconds = count * (unit === "minute" ? 60000 : 3600000);
    if (count < 1 || !Number.isSafeInteger(milliseconds))
      throw new Error("The interval must be a positive whole number.");
    return {
      milliseconds,
      description: `Every ${count === 1 ? "" : `${count} `}${unit}${count === 1 ? "" : "s"}`,
    };
  }
  const calendar = normalized.match(
    /^(everyday|daily|every day|weekdays|every weekday|every (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)) (?:at )?(noon|midnight|\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)(?: in the (morning|afternoon|evening)| at night)?$/,
  );
  if (!calendar) throw new Error(scheduleHelp);
  const [, frequency, clock, period] = calendar;
  let hour = 0;
  let minute = 0;
  if (clock === "noon" || clock === "midnight") {
    hour = clock === "noon" ? 12 : 0;
    if (period) throw new Error("Use noon or midnight without a time of day.");
  } else {
    const time = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/.exec(clock)!;
    hour = Number(time[1]);
    minute = Number(time[2] ?? 0);
    const implied = period ? (period === "morning" ? "am" : "pm") : undefined;
    const meridiem = time[3] ?? implied;
    if (time[3] && implied && time[3] !== implied)
      throw new Error("The time and time of day conflict.");
    if (minute > 59 || hour > (meridiem ? 12 : 23) || (meridiem && hour < 1))
      throw new Error("Use a valid time, such as 7am or 19:30.");
    if (!meridiem && !clock.includes(":"))
      throw new Error("Specify am or pm, or use a 24-hour time such as 07:00.");
    if (meridiem) hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  }
  const day = days.indexOf(frequency.replace(/^every /, ""));
  const weekdays = frequency.includes("weekday");
  const description =
    day >= 0
      ? `Every ${days[day][0].toUpperCase()}${days[day].slice(1)}`
      : weekdays
        ? "Every weekday"
        : "Every day";
  return {
    expressions: [
      `${minute} ${hour} * * ${day >= 0 ? day : weekdays ? "1-5" : "*"}`,
    ],
    description: `${description} at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function legacyDescription(expression: string) {
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
  return "Saved calendar schedule";
}

export function readWatchSchedule(
  settings: Record<string, Json>,
  now = new Date(),
) {
  const timeZone = settings.timeZone ?? "UTC";
  if (typeof timeZone !== "string")
    throw new Error("Time zone must be a string.");
  new Intl.DateTimeFormat("en", { timeZone });
  let parsed: Schedule;
  if (settings.compiled !== undefined) {
    const compiled = compiledWatchScheduleSchema.parse(settings.compiled);
    if (
      compiled.schedule !== settings.schedule ||
      compiled.timeZone !== timeZone
    )
      throw new Error("Schedule changed. Save it again to prepare its timing.");
    if ((compiled.intervalMinutes !== null) === compiled.expressions.length > 0)
      throw new Error("Use either a fixed interval or calendar expressions.");
    for (const expression of compiled.expressions)
      if (expression.split(/\s+/).length !== 5)
        throw new Error(
          "Calendar expressions must have five fields (minute precision).",
        );
    parsed =
      compiled.intervalMinutes === null
        ? compiled
        : {
            milliseconds: compiled.intervalMinutes * 60000,
            description: compiled.description,
          };
  } else if (settings.schedule !== undefined) {
    if (typeof settings.schedule !== "string")
      throw new Error("Schedule must be a sentence.");
    parsed = parseLegacySchedule(settings.schedule);
  } else {
    if (typeof settings.expression !== "string") throw new Error(scheduleHelp);
    parsed = {
      expressions: [settings.expression],
      description: legacyDescription(settings.expression),
    };
  }
  if ("milliseconds" in parsed) {
    const interval = parsed.milliseconds;
    if (!Number.isSafeInteger(interval) || interval < 60000)
      throw new Error(
        "The interval must be a positive whole number of minutes.",
      );
    // Fixed intervals use UTC boundaries so they do not reset each hour or at DST.
    const previous = (Math.ceil(now.getTime() / interval) - 1) * interval;
    const next = (Math.floor(now.getTime() / interval) + 1) * interval;
    return {
      description: parsed.description,
      timeZone,
      previous: new Date(previous).toISOString(),
      next: new Date(next).toISOString(),
    };
  }
  const options = { tz: timeZone, currentDate: now };
  const occurrences = parsed.expressions.map((expression) => {
    const previous = CronExpressionParser.parse(expression, options)
      .prev()
      .toISOString();
    const next = CronExpressionParser.parse(expression, options)
      .next()
      .toISOString();
    if (!previous || !next)
      throw new Error("No schedule occurrence available.");
    return { previous, next };
  });
  return {
    description: parsed.description,
    timeZone,
    previous: occurrences
      .map((value) => value.previous)
      .sort()
      .at(-1)!,
    next: occurrences.map((value) => value.next).sort()[0],
  };
}
