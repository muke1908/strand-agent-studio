import { z } from "zod";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const schema = z.record(z.string(), z.unknown());
export const allowedFoldersSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine(
        (folder) => !folder.includes("\0"),
        "Folder paths cannot contain null bytes.",
      ),
  )
  .max(20);
export const reference = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValue }).strict(),
  z.object({ source: z.literal("input"), pointer: z.string() }).strict(),
  z.object({ source: z.literal("trigger"), pointer: z.string() }).strict(),
  z
    .object({
      source: z.literal("stage"),
      stageId: identifier,
      agentId: identifier,
      pointer: z.string(),
    })
    .strict(),
]);
export const agentSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(120),
    model: z.string().max(120).optional(),
    allowedFolders: allowedFoldersSchema.optional(),
    instructions: z.string().max(50000).default(""),
    skills: z.array(identifier).default([]),
  })
  .strict();
export const stageSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(120),
    instructions: z.string().max(50000).default(""),
    skills: z.array(identifier).default([]),
    inputs: z.record(z.string(), reference).default({}),
    outputSchema: schema,
    agents: z.array(agentSchema).min(1).max(12),
  })
  .strict();
export const workflowSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(120),
    description: z.string().max(2000).default(""),
    inputSchema: schema,
    stages: z.array(stageSchema).min(1).max(24),
    result: reference.optional(),
    layout: z
      .record(
        z.string(),
        z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
      )
      .default({}),
  })
  .strict();
export const skillSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(120),
    description: z.string().max(2000).default(""),
    instructions: z.string().min(1).max(50000),
  })
  .strict();
export const watchSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(120),
    workflowId: identifier,
    enabled: z.boolean(),
    policyId: identifier,
    settings: z.record(z.string(), jsonValue),
    inputBindings: z.record(z.string(), reference),
    cooldownSeconds: z.number().int().min(0).max(86400).default(60),
    maxRunsPerHour: z.number().int().min(1).max(60).default(10),
  })
  .strict();
export type Workflow = z.infer<typeof workflowSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type Reference = z.infer<typeof reference>;
export type Watch = z.infer<typeof watchSchema>;
export type Schema = z.infer<typeof schema>;
export type Saved<T> = { value: T; revision: string };
export type Status =
  "queued" | "running" | "completed" | "blocked" | "cancelled";
export type Attempt = {
  id: string;
  status: Status;
  error?: string;
  output?: Json;
};
export type Unit = {
  stageId: string;
  agentId: string;
  name: string;
  status: Status;
  attempts: Attempt[];
  output?: Json;
};
export type UnitDetails = {
  unit: Unit;
  kind: "contract" | "agent";
  input: Json;
  output?: Json;
};
export type Run = {
  id: string;
  workflowId: string;
  workflowName: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
  requestId: string;
  allowAllTools?: boolean;
  allowedFolders?: string[];
  trigger?: { watchId: string; eventId: string; reason: string };
  error?: string;
  currentStage?: string;
  units: Record<string, Unit>;
  result?: Json;
};
export type Decision = {
  eventId: string;
  resourceId: string;
  reason: string;
  input: Json;
  observedAt: string;
  status: "pending" | "launched" | "superseded" | "rejected";
  runId?: string;
  error?: string;
};
export type WatchState = {
  id: string;
  cursor?: Json;
  nextCheck: string;
  lastChecked?: string;
  error?: string;
  decisions: Decision[];
};
