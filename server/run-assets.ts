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

function* fileReferences(value: Json, published = false): Generator<string> {
  if (typeof value === "string" && path.isAbsolute(value)) yield value;
  else if (Array.isArray(value))
    for (const child of value) yield* fileReferences(child, published);
  else if (value !== null && typeof value === "object")
    for (const [key, child] of Object.entries(value))
      if (
        published ||
        key === "report" ||
        key === "reportPaths" ||
        key === "files" ||
        /artifacts?$/i.test(key)
      )
        yield* fileReferences(child, true);
}

export function runAssets(store: RunStore, id: string): Uint8Array {
  const run = store.get(id);
  if (run.status !== "completed" && run.status !== "blocked")
    fail("Assets can only be downloaded from a completed or blocked run.");
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

  if (run.status === "completed")
    add(path.join(store.directory(id), "result.json"), "result.json");
  else
    files["run-status.json"] = Buffer.from(
      JSON.stringify(
        { id: run.id, status: run.status, error: run.error },
        null,
        2,
      ),
    );
  let acceptedOutputs = 0;

  for (const stage of snapshot.workflow.stages.slice(-1)) {
    for (const agent of stage.agents) {
      const artifact = outputArtifactName(
        stage.id,
        agent.id,
        run.units[`${stage.id}/${agent.id}`]?.visitId,
      );
      const raw = store.readArtifactIfPresent(id, artifact);
      if (raw === undefined && run.status === "blocked") continue;
      const { output } = acceptedOutputSchema.parse(raw);
      acceptedOutputs++;
      if (run.status === "blocked")
        add(
          path.join(store.directory(id), artifact),
          `outputs/${stage.id}-${agent.id}.json`,
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

      for (const file of new Set(fileReferences(output))) {
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
        const relative = path
          .relative(folders[folderIndex], resolved)
          .split(path.sep)
          .join("/");
        if (relative.includes("\\"))
          fail(`Unsupported asset filename: ${relative}`);
        add(
          file,
          `outputs/${stage.id}-${agent.id}/${folderIndex + 1}/${relative}`,
        );
        included.add(resolved);
      }
    }
  }
  if (!acceptedOutputs && run.status === "blocked")
    fail("This blocked run has no accepted final-stage outputs to download.");
  return zipSync(files);
}
