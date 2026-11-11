import type { Json, Schema } from "../shared/contracts.ts";
import {
  compiledWatchScheduleSchema,
  readWatchSchedule,
} from "../shared/watch-schedule.ts";
import { z } from "zod";

export type Candidate = {
  eventId: string;
  resourceId: string;
  payload: Json;
  reason: string;
};
export type Evaluation = { cursor: Json; candidates: Candidate[] };
export interface WatchPolicy {
  id: string;
  name: string;
  description: string;
  settingsSchema: Schema;
  evaluate(
    settings: Record<string, Json>,
    cursor: Json | undefined,
    now: Date,
  ): Promise<Evaluation>;
}

export const cronPolicy: WatchPolicy = {
  id: "schedule-cron",
  name: "Scheduled occurrence",
  description:
    "Run on a calendar schedule. Missed occurrences coalesce to the latest.",
  settingsSchema: {
    type: "object",
    required: ["timeZone"],
    oneOf: [{ required: ["schedule"] }, { required: ["expression"] }],
    properties: {
      schedule: {
        type: "string",
        title: "Schedule",
        description:
          "Describe when to run. AI prepares the timing once when saving.",
        maxLength: 2000,
      },
      compiled: z.toJSONSchema(compiledWatchScheduleSchema, {
        target: "draft-7",
      }),
      expression: { type: "string" },
      timeZone: { type: "string", title: "Time zone" },
    },
    additionalProperties: false,
  },
  async evaluate(raw, cursor, now) {
    const { previous: latest } = readWatchSchedule(raw, now);
    const candidates =
      cursor !== undefined && cursor !== latest
        ? [
            {
              eventId: latest,
              resourceId: "schedule",
              payload: { scheduledAt: latest },
              reason: `Scheduled for ${latest}`,
            },
          ]
        : [];
    return { cursor: latest, candidates };
  },
};
