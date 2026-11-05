import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { z } from "zod";
import type { Json } from "../shared/contracts.ts";
import { acceptedOutputSchema, outputArtifactName } from "./run-checkpoint.ts";
import type { RunStore } from "./run-store.ts";

const reportSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

function fail(message: string, status = 409): never {
  throw Object.assign(new Error(message), { status });
}

function containingFolder(file: string, folders: string[]): number {
  return folders.findIndex((folder) => {
    const relative = path.relative(folder, file);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  });
}

function* fileReferences(value: Json): Generator<string> {
  if (typeof value === "string" && path.isAbsolute(value)) yield value;
  else if (value !== null && typeof value === "object")
    for (const child of Object.values(value)) yield* fileReferences(child);
}

export function runAssets(store: RunStore, id: string): Uint8Array {
  const run = store.get(id);
  if (run.status !== "completed")
    fail("Assets can only be downloaded from a completed run.");
  store.verify(id);
  const snapshot = store.snapshot(id);
  const files: Record<string, Uint8Array> = {};
  const limit = 64 * 1024 * 1024;
  let total = 0;
  let entries = 0;

  function add(file: string, name: string, sha256?: string) {
    if (++entries > 10000)
      fail("This run has too many asset files to download as a ZIP.", 413);
    if (Object.hasOwn(files, name)) fail(`Duplicate asset name: ${name}`);
    if (!fs.lstatSync(file).isFile())
      fail(`Asset is not a regular file: ${file}`);
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) fail(`Asset is not a regular file: ${file}`);
      if (total + stat.size > limit)
        fail("Run assets exceed the 64 MiB ZIP download limit.", 413);
      const bytes = fs.readFileSync(fd);
      total += bytes.length;
      if (total > limit)
        fail("Run assets exceed the 64 MiB ZIP download limit.", 413);
      if (sha256 && createHash("sha256").update(bytes).digest("hex") !== sha256)
        fail(`Published report changed since this run completed: ${file}`);
      files[name] = bytes;
    } finally {
      fs.closeSync(fd);
    }
  }

  function walk(directory: string, prefix: string, depth = 0) {
    if (depth > 32) fail("Asset directory nesting is too deep.", 413);
    if (++entries > 10000)
      fail("This run has too many asset files to download as a ZIP.", 413);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.includes("\\"))
        fail(`Unsupported asset filename: ${entry.name}`);
      const file = path.join(directory, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink())
        fail(`Asset downloads do not follow symbolic links: ${file}`);
      if (entry.isDirectory()) walk(file, name, depth + 1);
      else if (entry.isFile()) add(file, name);
      else fail(`Asset is not a regular file or directory: ${file}`);
    }
  }

  const directory = store.directory(id);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (/^[a-zA-Z0-9_-]+\.json$/.test(entry.name))
      add(file, `execution/${entry.name}`);
    else if (entry.name === "attempts") {
      if (!entry.isDirectory()) fail("Run attempts must be a directory.");
      walk(file, "execution/attempts");
    }
  }

  for (const stage of snapshot.workflow.stages) {
    for (const agent of stage.agents) {
      const { output } = acceptedOutputSchema.parse(
        store.readArtifact(
          id,
          outputArtifactName(
            stage.id,
            agent.id,
            run.units[`${stage.id}/${agent.id}`]?.visitId,
          ),
        ),
      );
      const folders = agent.allowedFolders ?? snapshot.allowedFolders ?? [];
      const included = new Set<string>();
      const report =
        output && typeof output === "object" && !Array.isArray(output)
          ? output.report
          : undefined;
      if (
        report &&
        typeof report === "object" &&
        !Array.isArray(report) &&
        Object.hasOwn(report, "path")
      ) {
        const parsed = reportSchema.safeParse(report);
        if (!parsed.success)
          fail(`Invalid report metadata for ${stage.name} / ${agent.name}.`);
        const metadata = parsed.data;
        if (!path.isAbsolute(metadata.path))
          fail("Published reports must have an absolute path.");
        const resolved = fs.realpathSync(metadata.path);
        if (containingFolder(resolved, folders) < 0)
          fail(
            "Published report is outside this agent's pinned allowed folders.",
          );
        const basename = path
          .basename(metadata.path)
          .replace(/[^a-zA-Z0-9._-]/g, "_");
        add(
          metadata.path,
          `reports/${stage.id}-${agent.id}/${basename}`,
          metadata.sha256,
        );
        included.add(resolved);
      }

      if (stage.id !== snapshot.workflow.stages.at(-1)?.id) continue;
      for (const file of new Set(fileReferences(output))) {
        // Final outputs also cite source paths; only export within pinned grants.
        if (containingFolder(file, folders) < 0) continue;
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) continue;
        if (stat.isSymbolicLink())
          fail(`Asset downloads do not follow symbolic links: ${file}`);
        const resolved = fs.realpathSync(file);
        const folderIndex = containingFolder(resolved, folders);
        if (folderIndex < 0)
          fail("Output asset is outside this agent's pinned allowed folders.");
        if (included.has(resolved)) continue;
        const relative = path.relative(folders[folderIndex], resolved);
        if (relative.includes("\\"))
          fail(`Unsupported asset filename: ${relative}`);
        add(
          file,
          `outputs/${stage.id}-${agent.id}/${folderIndex + 1}/${relative.split(path.sep).join("/")}`,
        );
        included.add(resolved);
      }
    }
  }
  return zipSync(files);
}
