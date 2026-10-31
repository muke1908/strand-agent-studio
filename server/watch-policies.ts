import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { Json, Schema } from "../shared/contracts.ts";

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
const cronSettings = z.object({
  expression: z.string(),
  timeZone: z.string().default("UTC"),
});
const headSettings = z.object({ prUrl: z.string().url() });

export const cronPolicy: WatchPolicy = {
  id: "schedule-cron",
  name: "Scheduled occurrence",
  description:
    "Run on a calendar schedule. Missed occurrences coalesce to the latest.",
  settingsSchema: {
    type: "object",
    required: ["expression", "timeZone"],
    properties: {
      expression: { type: "string", title: "Cron expression" },
      timeZone: { type: "string", title: "Time zone" },
    },
    additionalProperties: false,
  },
  async evaluate(raw, cursor, now) {
    const settings = cronSettings.parse(raw);
    const latest = CronExpressionParser.parse(settings.expression, {
      tz: settings.timeZone,
      currentDate: now,
    })
      .prev()
      .toISOString();
    if (latest === null) throw new Error("No cron occurrence available");
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

export function adoHeadPolicy(token?: string): WatchPolicy {
  return {
    id: "ado-pr-head",
    name: "PR source changed",
    description:
      "Watch an active Azure DevOps PR and run on a new source commit.",
    settingsSchema: {
      type: "object",
      required: ["prUrl"],
      properties: { prUrl: { type: "string", title: "Azure DevOps PR URL" } },
      additionalProperties: false,
    },
    async evaluate(raw, cursor) {
      if (!token)
        throw new Error("Set ADO_PAT on the host to enable this policy");
      const { prUrl } = headSettings.parse(raw);
      const url = new URL(prUrl);
      const match =
        /^\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\/?$/.exec(
          url.pathname,
        );
      if (
        url.protocol !== "https:" ||
        url.hostname !== "dev.azure.com" ||
        !match ||
        url.username ||
        url.password
      )
        throw new Error("Expected an Azure DevOps PR URL");
      const [, organization, project, repository, id] = match;
      const endpoint = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repository}/pullrequests/${id}?api-version=7.1`;
      const response = await fetch(endpoint, {
        headers: {
          Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(`PR lookup failed (${response.status})`);
      const pr = z
        .object({
          status: z.string(),
          lastMergeSourceCommit: z.object({
            commitId: z.string().regex(/^[a-f0-9]{40}$/i),
          }),
        })
        .parse(await response.json());
      const head = pr.lastMergeSourceCommit.commitId;
      const candidates =
        pr.status === "active" && cursor !== undefined && cursor !== head
          ? [
              {
                eventId: head,
                resourceId: prUrl,
                payload: { prUrl, head },
                reason: `Source changed to ${head.slice(0, 8)}`,
              },
            ]
          : [];
      return { cursor: head, candidates };
    },
  };
}
