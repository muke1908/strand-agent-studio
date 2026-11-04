import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstructionDirectory, Workflow } from "../shared/contracts.ts";

function fileError(action: string, file: string, error: unknown): Error {
  return Object.assign(
    new Error(
      `${action} "${file}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    ),
    { status: 400 },
  );
}

export function readInstructionFile(file: string): string {
  try {
    if (!path.isAbsolute(file))
      throw new Error("Instructions file must be an absolute path.");
    if (path.extname(file).toLowerCase() !== ".md")
      throw new Error("Instructions file must be a .md file.");
    const stat = fs.statSync(file);
    if (!stat.isFile())
      throw new Error("Instructions file must be a regular file.");
    if (stat.size > 200000)
      throw new Error("Instructions file exceeds the 50,000-character limit.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      fs.readFileSync(file),
    );
    if (!text.trim()) throw new Error("Instructions file cannot be empty.");
    if (text.length > 50000)
      throw new Error("Instructions file exceeds the 50,000-character limit.");
    return text;
  } catch (error) {
    throw fileError("Cannot read instructions file", file, error);
  }
}

export function resolveWorkflowInstructions(workflow: Workflow): Workflow {
  return {
    ...workflow,
    stages: workflow.stages.map((stage) => ({
      ...stage,
      agents: stage.agents.map((agent) => ({
        ...agent,
        instructions: agent.instructionsFile
          ? readInstructionFile(agent.instructionsFile)
          : agent.instructions,
      })),
    })),
  };
}

export function instructionDirectory(
  directory = os.homedir(),
): InstructionDirectory {
  try {
    if (!path.isAbsolute(directory))
      throw new Error("Directory must be an absolute path.");
    const resolved = fs.realpathSync(directory);
    const entries: InstructionDirectory["entries"] = fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() ||
          (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md"),
      )
      .map((entry) => ({
        name: entry.name,
        path: path.join(resolved, entry.name),
        kind: entry.isDirectory() ? "directory" : "file",
      }));
    entries.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    );
    return {
      directory: resolved,
      parent:
        path.dirname(resolved) === resolved ? null : path.dirname(resolved),
      entries,
    };
  } catch (error) {
    throw fileError("Cannot browse instructions directory", directory, error);
  }
}
