import fs from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";
import {
  skillSchema,
  workflowSchema,
  watchSchema,
} from "../shared/contracts.ts";
import type { Saved, Skill, Workflow, Watch } from "../shared/contracts.ts";
import {
  claim,
  digest,
  itemPath,
  privateDirectory,
  readJson,
  writeJson,
} from "./files.ts";
import { validateWorkflow } from "./validation.ts";
import { resolveWorkflowFolders } from "./allowed-folders.ts";
import { resolveWorkflowInstructions } from "./instruction-files.ts";

export function createCatalog(root: string) {
  privateDirectory(root);
  const workflowHistory = path.join(root, "workflow-history.json");
  function list<T>(collection: string, contract: ZodType<T>): Saved<T>[] {
    const directory = path.join(root, collection);
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const value = contract.parse(readJson(path.join(directory, name)));
        return { value, revision: digest(value) };
      });
  }
  function get<T>(
    collection: string,
    id: string,
    contract: ZodType<T>,
  ): Saved<T> {
    const file = itemPath(root, collection, id);
    if (!fs.existsSync(file))
      throw Object.assign(new Error("Not found"), { status: 404 });
    const value = contract.parse(readJson(file));
    return { value, revision: digest(value) };
  }
  function save<T extends { id: string }>(
    collection: string,
    value: T,
    revision?: string,
  ): Saved<T> {
    const unlock = claim(itemPath(root, "claims", `${collection}-${value.id}`));
    try {
      const file = itemPath(root, collection, value.id);
      if (
        fs.existsSync(file)
          ? revision !== digest(readJson(file))
          : revision !== undefined
      ) {
        throw Object.assign(
          new Error("This item changed. Reload before saving."),
          { status: 409 },
        );
      }
      writeJson(file, value);
      return { value, revision: digest(value) };
    } finally {
      unlock();
    }
  }
  return {
    workflows: () => list("workflows", workflowSchema),
    workflow: (id: string) => get("workflows", id, workflowSchema),
    hasWorkflowHistory: () => fs.existsSync(workflowHistory),
    skills: () => list("skills", skillSchema),
    watches: () => list("watches", watchSchema),
    watch: (id: string) => get("watches", id, watchSchema),
    saveWorkflow(value: Workflow, revision?: string) {
      const parsed = resolveWorkflowFolders(workflowSchema.parse(value));
      resolveWorkflowInstructions(parsed);
      const skills = list("skills", skillSchema).map((item) => item.value);
      try {
        validateWorkflow(parsed, skills);
      } catch (error) {
        throw Object.assign(
          error instanceof Error ? error : new Error(String(error)),
          { status: 400 },
        );
      }
      return save("workflows", parsed, revision);
    },
    deleteWorkflow(id: string, revision: string): void {
      const unlock = claim(itemPath(root, "claims", `workflows-${id}`));
      try {
        const current = get("workflows", id, workflowSchema);
        if (current.revision !== revision)
          throw Object.assign(
            new Error("This workflow changed. Reload before deleting."),
            { status: 409 },
          );
        const enabled = list("watches", watchSchema).filter(
          (item) =>
            (item.value.workflowId === id ||
              item.value.action?.workflowId === id) &&
            item.value.enabled,
        );
        if (enabled.length)
          throw Object.assign(
            new Error(
              `Pause these watches before deleting: ${enabled.map((item) => item.value.name).join(", ")}.`,
            ),
            { status: 409 },
          );
        if (!fs.existsSync(workflowHistory))
          writeJson(workflowHistory, { initialized: true });
        fs.unlinkSync(itemPath(root, "workflows", id));
      } finally {
        unlock();
      }
    },
    saveSkill: (value: Skill, revision?: string) =>
      save("skills", skillSchema.parse(value), revision),
    saveWatch(value: Watch, revision?: string) {
      const parsed = watchSchema.parse(value);
      const previous = list("watches", watchSchema).find(
        (item) => item.value.id === parsed.id,
      )?.value;
      const source = (watch: Watch) => ({
        workflowId: watch.workflowId,
        policyId: watch.policyId,
        settings: watch.settings,
        inputBindings: watch.inputBindings,
        action: watch.action ?? null,
      });
      if (previous && digest(source(previous)) !== digest(source(parsed)))
        throw Object.assign(
          new Error(
            "Create a new watch to change its source, workflow or input bindings.",
          ),
          { status: 409 },
        );
      return save("watches", parsed, revision);
    },
  };
}
export type Catalog = ReturnType<typeof createCatalog>;
