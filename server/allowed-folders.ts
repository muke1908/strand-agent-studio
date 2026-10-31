import fs from "node:fs";
import path from "node:path";
import { allowedFoldersSchema } from "../shared/contracts.ts";
import type { Workflow } from "../shared/contracts.ts";

export function resolveWorkflowFolders(workflow: Workflow): Workflow {
  return {
    ...workflow,
    stages: workflow.stages.map((stage) => ({
      ...stage,
      agents: stage.agents.map((agent) => ({
        ...agent,
        ...(agent.allowedFolders === undefined
          ? {}
          : { allowedFolders: resolveAllowedFolders(agent.allowedFolders) }),
      })),
    })),
  };
}

export function resolveAllowedFolders(folders: string[]): string[] {
  const resolved = allowedFoldersSchema.parse(folders).map((folder) => {
    if (!path.isAbsolute(folder))
      throw Object.assign(
        new Error(`Allowed folder must be an absolute path: ${folder}`),
        { status: 400 },
      );
    try {
      const directory = fs.realpathSync(folder);
      if (!fs.statSync(directory).isDirectory())
        throw Object.assign(
          new Error(`Allowed folder must be a directory: ${folder}`),
          { status: 400 },
        );
      return directory;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        [
          "ENOENT",
          "ENOTDIR",
          "EACCES",
          "EPERM",
          "ELOOP",
          "ENAMETOOLONG",
        ].includes(String(error.code))
      )
        throw Object.assign(
          new Error(
            `Cannot access allowed folder "${folder}": ${error.message}`,
            { cause: error },
          ),
          { status: 400 },
        );
      throw error;
    }
  });
  return [...new Set(resolved)].sort();
}
