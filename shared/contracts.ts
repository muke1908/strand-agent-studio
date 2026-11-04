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
      source: z.literal("loop"),
      pointer: z.string(),
      default: jsonValue.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("stage"),
      stageId: identifier,
      agentId: identifier,
      pointer: z.string(),
    })
    .strict(),
]);
export const loopOperators = [
  "equals",
  "notEquals",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
] as const;
export const loopSchema = z
  .object({
    targetStageId: identifier,
    condition: z
      .object({
        agentId: identifier,
        pointer: z.string(),
        operator: z.enum(loopOperators),
        value: jsonValue,
      })
      .strict(),
    maxIterations: z.number().int().min(1).max(20),
    feedback: z.record(z.string(), reference),
  })
  .strict();
export const loopContextSchema = z.object({
  stageId: identifier,
  iteration: z.number().int().positive(),
  maxIterations: z.number().int().positive(),
  feedback: jsonValue,
});
export const loopRouteSchema = z.object({
  kind: z.enum(["repeat", "continue", "limit", "skipped"]),
  value: jsonValue.optional(),
  targetStageId: identifier.optional(),
  feedback: jsonValue.optional(),
});
export type LoopContext = z.infer<typeof loopContextSchema>;
export const agentSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(120),
    model: z.string().max(120).optional(),
    allowedFolders: allowedFoldersSchema.optional(),
    instructionsFile: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine(
        (file) => !file.includes("\0"),
        "File paths cannot contain null bytes.",
      )
      .optional(),
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
    loop: loopSchema.optional(),
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
    allowAllTools: z.boolean().optional(),
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
export type InstructionDirectory = {
  directory: string;
  parent: string | null;
  entries: { name: string; path: string; kind: "directory" | "file" }[];
};
export type Status =
  "queued" | "running" | "completed" | "blocked" | "cancelled";
export const stageSkipSchema = z
  .object({
    stageId: identifier,
    reason: z.string().trim().min(1).max(2000),
    allowPublication: z.boolean(),
    at: z.string().datetime(),
  })
  .strict();
export type StageSkip = z.infer<typeof stageSkipSchema>;
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
  status: Status | "skipped";
  attempts: Attempt[];
  output?: Json;
  reusedFrom?: string;
  visitId?: string;
};
export type StageVisit = {
  id: string;
  stageId: string;
  iteration: number;
  units: Record<string, Unit>;
  loopContext?: LoopContext;
  route?: z.infer<typeof loopRouteSchema>;
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
  continuation?: { sourceRunId: string; fromStageId: string };
  stageSkips?: StageSkip[];
  visits?: StageVisit[];
  currentVisit?: string;
};
export type ResultSummary =
  | { status: "generating" }
  | { status: "completed"; lines: string[] }
  | { status: "failed"; error: string };
export type RunDetails = Run & {
  resultSummary?: ResultSummary;
  stages: {
    id: string;
    name: string;
    agents: Pick<Agent, "id" | "name">[];
  }[];
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
export type WatchDashboardItem = Saved<Watch> & {
  state: WatchState;
  latestRun?: Pick<
    Run,
    "id" | "status" | "createdAt" | "updatedAt" | "error" | "result"
  >;
  previousResultRun?: Pick<Run, "id" | "updatedAt"> & { result: Json };
};
