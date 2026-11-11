import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { RunStore } from "./run-store.ts";
import { readJson, writeJson } from "./files.ts";
import { assertAttemptStopped } from "./process-runner.ts";

const resourceSchema = z
  .object({
    kind: z.literal("git-worktree"),
    runId: z.string(),
    repository: z.string(),
    workspace: z.string(),
    branch: z.string(),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  })
  .strict();

export function cleanupRunWorktrees(store: RunStore, id: string): void {
  const attempts = path.join(store.directory(id), "attempts");
  if (!fs.existsSync(attempts)) return;
  const directories = fs
    .readdirSync(attempts)
    .map((name) => path.join(attempts, name));
  const registrations = directories
    .map((directory) => path.join(directory, "worktree.json"))
    .filter((file) => fs.existsSync(file));
  if (!registrations.length) return;
  store.verify(id);
  const snapshot = store.snapshot(id);
  const data = snapshot.paths?.WORKFLOW_DATA;
  if (!data)
    throw new Error("Owned worktree cleanup requires pinned WORKFLOW_DATA.");
  for (const directory of directories) {
    if (!fs.lstatSync(directory).isDirectory())
      throw new Error(
        "Attempt directory identity changed; refusing workspace cleanup.",
      );
    assertAttemptStopped(directory, true);
  }
  const expected = path.join(data, snapshot.workflow.id, "workspaces", id);
  const removed = new Set<string>();
  for (const file of registrations) {
    if (!fs.lstatSync(file).isFile())
      throw new Error("Worktree registration must be a regular file.");
    const resource = resourceSchema.parse(readJson(file));
    if (
      resource.runId !== id ||
      resource.workspace !== expected ||
      resource.branch !== `refs/heads/strand/${snapshot.workflow.id}/${id}` ||
      !(snapshot.allowedFolders ?? []).includes(resource.repository)
    )
      throw new Error(
        "Worktree ownership does not match the pinned run; refusing cleanup.",
      );
    const receiptFile = path.join(path.dirname(file), "worktree-cleanup.json");
    if (fs.existsSync(receiptFile)) {
      if (!fs.lstatSync(receiptFile).isFile())
        throw new Error("Worktree cleanup receipt must be a regular file.");
      const receipt = readJson(receiptFile) as Record<string, unknown>;
      if (
        receipt.status === "removed" &&
        Object.entries(resource).every(
          ([key, value]) => receipt[key] === value,
        ) &&
        !fs.lstatSync(expected, { throwIfNoEntry: false })
      )
        continue;
    }
    if (fs.realpathSync(resource.repository) !== resource.repository)
      throw new Error("Owned repository path changed; refusing cleanup.");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", resource.repository, ...args], {
        encoding: "utf8",
      });
    if (
      fs.realpathSync(git("rev-parse", "--show-toplevel").trim()) !==
      resource.repository
    )
      throw new Error("Owned worktree repository is not the pinned Git root.");
    if (!removed.has(expected)) {
      const entry = fs.lstatSync(expected, { throwIfNoEntry: false });
      if (
        entry &&
        (!entry.isDirectory() || fs.realpathSync(expected) !== expected)
      )
        throw new Error("Owned workspace path changed; refusing cleanup.");
      const registered = git("worktree", "list", "--porcelain", "-z")
        .split("\0")
        .some(
          (field) =>
            field.startsWith("worktree ") &&
            path.resolve(field.slice("worktree ".length)) === expected,
        );
      if (registered) git("worktree", "remove", "--force", expected);
      else if (entry) {
        // The intent is registered before Git starts, so interrupted creation can leave a partial directory.
        fs.rmSync(expected, { recursive: true, force: true });
      }
      removed.add(expected);
    }
    if (git("for-each-ref", "--format=%(objectname)", resource.branch).trim())
      git("update-ref", "-d", resource.branch, resource.commit);
    writeJson(receiptFile, {
      ...resource,
      status: "removed",
      verifiedAt: new Date().toISOString(),
    });
  }
}
