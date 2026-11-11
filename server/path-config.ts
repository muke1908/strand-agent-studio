import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Workflow } from "../shared/contracts.ts";
import {
  resolveAllowedFolders,
  resolveWorkflowFolders,
} from "./allowed-folders.ts";
import { resolveWorkflowInstructions } from "./instruction-files.ts";

export const namedPathsSchema = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  z.string().min(1).max(4096),
);
export type NamedPaths = z.infer<typeof namedPathsSchema>;
export type PathConfig = {
  paths: NamedPaths;
  repository?: string;
};

export function pathConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PathConfig {
  const paths: NamedPaths = {};
  for (const [variable, value] of Object.entries(environment)) {
    if (!variable.startsWith("STRAND_PATH_")) continue;
    const name = variable.slice("STRAND_PATH_".length);
    const parsed = namedPathsSchema.parse({ [name]: value });
    paths[name] = resolveAllowedFolders([parsed[name]])[0];
  }
  const repository = environment.STRAND_WORKFLOWS_DIR
    ? resolveAllowedFolders([environment.STRAND_WORKFLOWS_DIR])[0]
    : undefined;
  if (repository) paths.WORKFLOW_REPO = repository;
  return { paths, ...(repository ? { repository } : {}) };
}

export function workflowDirectory(
  config: PathConfig,
  id: string,
): string | undefined {
  if (!config.repository) return undefined;
  return path.join(config.repository, "workflows", id);
}

export function resolvePathReferences<T>(value: T, paths: NamedPaths): T {
  function resolve(item: unknown): unknown {
    if (typeof item === "string")
      return item.replace(
        /\$\{STRAND_PATH_([A-Z][A-Z0-9_]*)\}/g,
        (_, name: string) => {
          if (!Object.hasOwn(paths, name))
            throw Object.assign(
              new Error(`Missing configured path: STRAND_PATH_${name}`),
              { status: 400 },
            );
          return paths[name];
        },
      );
    if (Array.isArray(item)) return item.map(resolve);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, field]) => [key, resolve(field)]),
      );
    return item;
  }
  return resolve(value) as T;
}

export function runtimeWorkflow(
  workflow: Workflow,
  config: PathConfig,
): Workflow {
  const resolved = resolvePathReferences(workflow, config.paths);
  return resolveWorkflowInstructions(
    resolveWorkflowFolders({
      ...resolved,
      stages: resolved.stages.map((stage) => ({
        ...stage,
        agents: stage.agents.map((agent) => {
          if (!Object.keys(config.paths).length) return agent;
          const shared = { ...agent };
          delete shared.allowedFolders;
          return shared;
        }),
      })),
    }),
    workflowDirectory(config, workflow.id),
  );
}

export function relativeInstructionFile(
  config: PathConfig,
  id: string,
  file: string,
): string {
  if (!config.repository || !path.isAbsolute(file)) return file;
  const base = workflowDirectory(config, id)!;
  const relative = path.relative(base, file);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw Object.assign(
      new Error(
        "Choose an instructions file inside this workflow's repository directory.",
      ),
      { status: 400 },
    );
  if (!fs.existsSync(file))
    throw Object.assign(
      new Error(`Instructions file does not exist: ${file}`),
      { status: 400 },
    );
  return relative.split(path.sep).join("/");
}
