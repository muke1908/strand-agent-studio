import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  workflowSchema,
  skillSchema,
  identifier,
} from "../shared/contracts.ts";
import { createCatalog } from "./catalog.ts";
import type { Catalog } from "./catalog.ts";
import { readJson, writeJson, digest, claim } from "./files.ts";
import { validateWorkflow } from "./validation.ts";
import { copilotBackend } from "./agent-backend.ts";
import type { AgentBackend } from "./agent-backend.ts";
import { createInputSchemaCompiler } from "./input-schema-compiler.ts";

const fileSchema = z.object({
  file: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const itemSchema = fileSchema.extend({ id: identifier, revision: z.string() });
const manifestSchema = z.object({
  formatVersion: z.literal(1),
  workflows: z.array(
    itemSchema.extend({ instructionFiles: z.array(fileSchema) }),
  ),
  skills: z.array(itemSchema),
  assets: z.array(fileSchema).optional(),
});
const importStateSchema = z.object({
  revisions: z.record(z.string(), z.string()),
});
const repositoryWorkflowSchema = workflowSchema
  .extend({ inputSchema: workflowSchema.shape.inputSchema.optional() })
  .refine(
    (value) =>
      value.inputSchema !== undefined || value.expectedInput !== undefined,
    {
      message: "Provide expectedInput or a legacy inputSchema.",
      path: ["expectedInput"],
    },
  );

export async function importWorkflowRepository(
  catalog: Catalog,
  root: string,
  refresh = false,
  backend?: AgentBackend,
): Promise<number> {
  const repository = catalog.config.repository;
  if (!repository) {
    if (refresh)
      throw new Error("Set STRAND_WORKFLOWS_DIR before refreshing workflows.");
    return 0;
  }
  if (!refresh && catalog.workflows().length) {
    console.log(
      "Existing workflow catalog retained. Use npm run workflows:refresh to import repository changes.",
    );
    return 0;
  }
  const unlock = claim(path.join(root, "workflow-import"));
  let compiler: ReturnType<typeof createInputSchemaCompiler> | undefined;
  try {
    const manifest = manifestSchema.parse(
      readJson(path.join(repository, "export.json")),
    );
    const revisionsFile = path.join(root, "workflow-import.json");
    const previous = fs.existsSync(revisionsFile)
      ? importStateSchema.parse(readJson(revisionsFile)).revisions
      : {};
    function verifiedFile(file: z.infer<typeof fileSchema>): string {
      if (path.isAbsolute(file.file))
        throw new Error(`Export file must be relative: ${file.file}`);
      const target = fs.realpathSync(path.resolve(repository!, file.file));
      const relative = path.relative(repository!, target);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error(`Export file escapes repository: ${file.file}`);
      if (
        createHash("sha256").update(fs.readFileSync(target)).digest("hex") !==
        file.sha256
      )
        throw new Error(`Workflow export checksum mismatch: ${file.file}`);
      return target;
    }
    const skills = manifest.skills.map((entry) => ({
      entry,
      value: skillSchema.parse(readJson(verifiedFile(entry))),
    }));
    const sources = manifest.workflows.map((entry) => {
      for (const instruction of entry.instructionFiles)
        verifiedFile(instruction);
      const value = repositoryWorkflowSchema.parse(
        readJson(verifiedFile(entry)),
      );
      return { entry, value };
    });
    for (const asset of manifest.assets ?? []) verifiedFile(asset);
    if (
      new Set(skills.map((item) => item.value.id)).size !== skills.length ||
      new Set(sources.map((item) => item.value.id)).size !== sources.length
    )
      throw new Error("Duplicate workflow or skill in repository export.");
    for (const item of [...skills, ...sources])
      if (item.value.id !== item.entry.id)
        throw new Error(`Export identity mismatch: ${item.entry.file}`);
    const workflows = [];
    for (const source of sources) {
      const local = catalog
        .workflows()
        .find((item) => item.value.id === source.value.id);
      let inputSchema = source.value.inputSchema;
      if (inputSchema === undefined) {
        if (
          local &&
          local.revision ===
            (previous[`workflows/${source.value.id}`] ??
              source.entry.revision) &&
          local.value.expectedInput === source.value.expectedInput
        ) {
          inputSchema = local.value.inputSchema;
        } else {
          compiler ??= createInputSchemaCompiler(
            root,
            backend ?? copilotBackend(),
          );
          inputSchema = await compiler.compile(
            z.string().parse(source.value.expectedInput),
            local?.value.inputSchema ?? { type: "object" },
          );
        }
      }
      const value = workflowSchema.parse({ ...source.value, inputSchema });
      validateWorkflow(
        catalog.runtimeWorkflow(value),
        skills.map((item) => item.value),
      );
      workflows.push({ entry: source.entry, value });
    }
    const plans = [
      ...skills.map((item) => ({ ...item, kind: "skills" as const })),
      ...workflows.map((item) => ({ ...item, kind: "workflows" as const })),
    ].map((item) => {
      const local = (
        item.kind === "skills" ? catalog.skills() : catalog.workflows()
      ).find((saved) => saved.value.id === item.value.id);
      const key = `${item.kind}/${item.value.id}`;
      if (
        local &&
        local.revision !== digest(item.value) &&
        local.revision !== (previous[key] ?? item.entry.revision)
      )
        throw new Error(
          `Local ${key} changed. Resolve the edit before refreshing; nothing was imported.`,
        );
      return { ...item, key, revision: local?.revision };
    });
    const revisions = { ...previous };
    for (const item of plans) {
      const saved =
        item.kind === "skills"
          ? catalog.saveSkill(skillSchema.parse(item.value), item.revision)
          : catalog.saveWorkflow(
              workflowSchema.parse(item.value),
              item.revision,
            );
      revisions[item.key] = saved.revision;
      writeJson(revisionsFile, { revisions });
    }
    console.log(
      `Imported ${workflows.length} workflows and ${skills.length} skills. No runs or watches were started.`,
    );
    return workflows.length;
  } finally {
    try {
      await compiler?.close();
    } finally {
      unlock();
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(process.env.PLATFORM_DATA_DIR || ".data");
  await importWorkflowRepository(
    createCatalog(root),
    root,
    process.argv.includes("--refresh"),
  );
}
