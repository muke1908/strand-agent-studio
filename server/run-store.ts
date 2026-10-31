import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  allowedFoldersSchema,
  jsonValue,
  skillSchema,
  workflowSchema,
} from "../shared/contracts.ts";
import type { Json, Run, Skill, Workflow } from "../shared/contracts.ts";
import {
  claim,
  digest,
  privateDirectory,
  readJson,
  writeJson,
} from "./files.ts";
import { identifier } from "../shared/contracts.ts";

const status = z.enum([
  "queued",
  "running",
  "completed",
  "blocked",
  "cancelled",
]);
const runSchema: z.ZodType<Run> = z.object({
  id: identifier,
  workflowId: identifier,
  workflowName: z.string(),
  status,
  createdAt: z.string(),
  updatedAt: z.string(),
  requestId: z.string(),
  allowAllTools: z.boolean().optional(),
  allowedFolders: allowedFoldersSchema.optional(),
  error: z.string().optional(),
  currentStage: z.string().optional(),
  result: jsonValue.optional(),
  trigger: z
    .object({ watchId: z.string(), eventId: z.string(), reason: z.string() })
    .optional(),
  units: z.record(
    z.string(),
    z.object({
      stageId: z.string(),
      agentId: z.string(),
      name: z.string(),
      status,
      output: jsonValue.optional(),
      attempts: z.array(
        z.object({
          id: z.string(),
          status,
          error: z.string().optional(),
          output: jsonValue.optional(),
        }),
      ),
    }),
  ),
});
const snapshotSchema = z.object({
  workflow: workflowSchema,
  skills: z.array(skillSchema),
  input: jsonValue,
  backendId: z.string(),
  allowAllTools: z.boolean().optional(),
  // Preserve historical run-wide grants during recovery.
  allowedFolders: allowedFoldersSchema.optional(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
const manifestSchema = z.record(z.string(), z.string());

export function createRunStore(root: string) {
  privateDirectory(root);
  const directory = (id: string) =>
    path.join(root, "runs", identifier.parse(id));
  function get(id: string): Run {
    const file = path.join(directory(id), "state.json");
    if (!fs.existsSync(file))
      throw Object.assign(new Error("Run not found"), { status: 404 });
    const state = runSchema.parse(readJson(file));
    if (state.id !== id) throw new Error("Run identity mismatch");
    return state;
  }
  function save(run: Run): void {
    run.updatedAt = new Date().toISOString();
    writeJson(path.join(directory(run.id), "state.json"), run);
  }
  function artifact(id: string, name: string, value: unknown): void {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name))
      throw new Error("Invalid artifact name");
    const file = path.join(directory(id), name);
    const manifestFile = path.join(directory(id), "manifest.json");
    const manifest = manifestSchema.parse(readJson(manifestFile));
    if (manifest[name]) {
      if (
        digest(readJson(file)) !== manifest[name] ||
        digest(value) !== manifest[name]
      )
        throw new Error(`Immutable artifact changed: ${name}`);
      return;
    }
    if (fs.existsSync(file))
      throw new Error(`Uncommitted artifact requires recovery: ${name}`);
    writeJson(file, value);
    manifest[name] = digest(value);
    writeJson(manifestFile, manifest);
  }
  function readArtifact(id: string, name: string): unknown {
    const manifest = manifestSchema.parse(
      readJson(path.join(directory(id), "manifest.json")),
    );
    if (!Object.hasOwn(manifest, name))
      throw new Error(`Artifact not recorded: ${name}`);
    const value = readJson(path.join(directory(id), name));
    if (digest(value) !== manifest[name])
      throw new Error(`Artifact integrity failed: ${name}`);
    return value;
  }
  return {
    directory,
    get,
    save,
    artifact,
    readArtifact,
    readArtifactIfPresent(id: string, name: string): unknown {
      const manifest = manifestSchema.parse(
        readJson(path.join(directory(id), "manifest.json")),
      );
      if (Object.hasOwn(manifest, name)) return readArtifact(id, name);
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name))
        throw new Error("Invalid artifact name");
      if (fs.existsSync(path.join(directory(id), name)))
        throw new Error(`Uncommitted artifact requires recovery: ${name}`);
      return undefined;
    },
    list(): Run[] {
      const base = path.join(root, "runs");
      if (!fs.existsSync(base)) return [];
      return fs
        .readdirSync(base)
        .filter((id) => fs.existsSync(path.join(base, id, "state.json")))
        .map(get)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    create(
      workflow: Workflow,
      skills: Skill[],
      input: Json,
      requestId: string,
      backendId: string,
      trigger?: Run["trigger"],
      allowAllTools = false,
    ): Run {
      const id = `run-${randomUUID()}`;
      const time = new Date().toISOString();
      const run: Run = {
        id,
        workflowId: workflow.id,
        workflowName: workflow.name,
        status: "queued",
        createdAt: time,
        updatedAt: time,
        requestId,
        allowAllTools,
        units: {},
        ...(trigger ? { trigger } : {}),
      };
      fs.mkdirSync(directory(id), { recursive: true });
      writeJson(path.join(directory(id), "manifest.json"), {});
      artifact(id, "snapshot.json", {
        workflow,
        skills,
        input,
        backendId,
        allowAllTools,
      });
      save(run);
      return run;
    },
    snapshot: (id: string): Snapshot =>
      snapshotSchema.parse(readArtifact(id, "snapshot.json")),
    lease: (id: string) => claim(path.join(directory(id), "execution")),
    verify(id: string): void {
      const manifest = manifestSchema.parse(
        readJson(path.join(directory(id), "manifest.json")),
      );
      for (const name of Object.keys(manifest)) readArtifact(id, name);
    },
    logs(id: string): string {
      get(id);
      const base = path.join(directory(id), "attempts");
      if (!fs.existsSync(base)) return "";
      return fs
        .readdirSync(base)
        .flatMap((attempt) =>
          ["stdout.log", "stderr.log"].map((name) => {
            const file = path.join(base, attempt, name);
            if (!fs.existsSync(file)) return "";
            const fd = fs.openSync(file, "r");
            try {
              const size = fs.fstatSync(fd).size;
              const bytes = Buffer.alloc(Math.min(size, 16000));
              fs.readSync(
                fd,
                bytes,
                0,
                bytes.length,
                Math.max(0, size - bytes.length),
              );
              return `${attempt} / ${name}\n${bytes.toString()}`;
            } finally {
              fs.closeSync(fd);
            }
          }),
        )
        .join("\n")
        .slice(-64000);
    },
  };
}
export type RunStore = ReturnType<typeof createRunStore>;
