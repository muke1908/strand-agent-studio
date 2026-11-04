import express from "express";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import {
  jsonValue,
  identifier,
  skillSchema,
  workflowSchema,
  watchSchema,
} from "../shared/contracts.ts";
import type { RunDetails, WatchDashboardItem } from "../shared/contracts.ts";
import type { Catalog } from "./catalog.ts";
import type { RunHost } from "./run-host.ts";
import type { Watcher } from "./watcher.ts";
import type { AgentBackend } from "./agent-backend.ts";
import { unitDetails } from "./unit-details.ts";
import { instructionDirectory } from "./instruction-files.ts";
import { runAssets } from "./run-assets.ts";

export function createApp(
  catalog: Catalog,
  host: RunHost,
  watcher: Watcher,
  backend: AgentBackend,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const hostname = request.hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
      response.status(403).json({ error: "Local access only" });
      return;
    }
    const origin = request.get("origin");
    const ports = [4200, 4201, Number(process.env.PORT || 4200)];
    const trustedOrigins = ports.flatMap((port) => [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ]);
    if (origin && !trustedOrigins.includes(origin)) {
      response.status(403).json({ error: "Untrusted origin" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/health", (_request, response) => response.json({ ok: true }));
  app.get("/api/settings", (_request, response) =>
    response.json({
      backend: { id: backend.id, ...backend.diagnostics() },
      execution:
        "Restricted file tools by default. Allow all tools at launch to enable web, shell and MCP tools with automatic tool and URL approval.",
      storage:
        "Filesystem snapshots, immutable outputs, durable watch decisions.",
    }),
  );
  app.get("/api/pipelines", (_request, response) =>
    response.json(catalog.workflows()),
  );
  app.get("/api/instruction-files", (request, response) => {
    const directory = z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0"))
      .optional()
      .parse(request.query.directory);
    response.json(instructionDirectory(directory));
  });
  app.get("/api/pipelines/:id", (request, response) =>
    response.json(catalog.workflow(request.params.id)),
  );
  app.put("/api/pipelines/:id", (request, response) => {
    const body = z
      .object({ value: workflowSchema, revision: z.string().optional() })
      .parse(request.body);
    if (body.value.id !== request.params.id)
      throw Object.assign(new Error("Workflow identity cannot change"), {
        status: 400,
      });
    response.json(catalog.saveWorkflow(body.value, body.revision));
  });
  app.delete("/api/pipelines/:id", (request, response) => {
    const body = z
      .object({ revision: z.string().min(1).max(160) })
      .strict()
      .parse(request.body);
    catalog.deleteWorkflow(request.params.id, body.revision);
    response.json({ deleted: true });
  });
  app.get("/api/skills", (_request, response) =>
    response.json(catalog.skills()),
  );
  app.put("/api/skills/:id", (request, response) => {
    const body = z
      .object({ value: skillSchema, revision: z.string().optional() })
      .parse(request.body);
    if (body.value.id !== request.params.id)
      throw Object.assign(new Error("Skill identity cannot change"), {
        status: 400,
      });
    response.json(catalog.saveSkill(body.value, body.revision));
  });
  app.post("/api/pipelines/:id/runs", (request, response) => {
    const body = z
      .object({
        input: jsonValue,
        requestId: z.string().min(1).max(160),
        allowAllTools: z.boolean().default(false),
      })
      .strict()
      .parse(request.body);
    response
      .status(202)
      .json(
        host.launch(
          request.params.id,
          body.input,
          body.requestId,
          undefined,
          body.allowAllTools,
        ),
      );
  });
  app.get("/api/pipeline-runs", (_request, response) =>
    response.json(host.store.list()),
  );
  app.get("/api/pipeline-runs/:id", (request, response) => {
    host.store.verify(request.params.id);
    const run: RunDetails = {
      ...host.store.get(request.params.id),
      resultSummary: host.summaries.read(request.params.id),
      stages: host.store
        .snapshot(request.params.id)
        .workflow.stages.map(({ id, name, agents }) => ({
          id,
          name,
          agents: agents.map(({ id, name }) => ({ id, name })),
        })),
    };
    response.json(run);
  });
  app.get("/api/pipeline-runs/:id/logs", (request, response) =>
    response.json({ content: host.store.logs(request.params.id) }),
  );
  app.get("/api/pipeline-runs/:id/assets", (request, response) => {
    const archive = runAssets(host.store, request.params.id);
    response
      .set("Cache-Control", "no-store")
      .type("application/zip")
      .attachment(`${request.params.id}-assets.zip`)
      .send(Buffer.from(archive));
  });
  app.get("/api/pipeline-runs/:id/activity", (request, response) => {
    const key = z.string().min(1).max(200).parse(request.query.unit);
    response.json(unitDetails(host.store, request.params.id, key));
  });
  app.post("/api/pipeline-runs/:id/resume", (request, response) =>
    response.json(host.resume(request.params.id)),
  );
  app.post("/api/pipeline-runs/:id/rerun", (request, response) => {
    const body = z
      .object({
        stageId: identifier,
        requestId: z.string().min(1).max(160),
      })
      .strict()
      .parse(request.body);
    response
      .status(202)
      .json(host.rerun(request.params.id, body.stageId, body.requestId));
  });
  app.post("/api/pipeline-runs/:id/skip", (request, response) => {
    const body = z
      .object({
        stageId: identifier,
        requestId: z.string().min(1).max(160),
        reason: z.string().trim().min(1).max(2000),
        allowPublication: z.boolean(),
      })
      .strict()
      .parse(request.body);
    response
      .status(202)
      .json(
        host.rerun(request.params.id, body.stageId, body.requestId, {
          reason: body.reason,
          allowPublication: body.allowPublication,
        }),
      );
  });
  app.post("/api/pipeline-runs/:id/result-summary", (request, response) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    response.status(202).json(host.summaries.generate(request.params.id));
  });
  app.post("/api/pipeline-runs/:id/stop", (request, response) =>
    response.json(host.stop(request.params.id)),
  );
  app.get("/api/watch-policies", (_request, response) =>
    response.json(
      watcher.policies.map(({ id, name, description, settingsSchema }) => ({
        id,
        name,
        description,
        settingsSchema,
      })),
    ),
  );
  app.get("/api/pipeline-watches", (_request, response) =>
    response.json(
      catalog
        .watches()
        .map((item) => ({ ...item, state: watcher.state(item.value.id) })),
    ),
  );
  app.get("/api/watch-dashboard", (_request, response) => {
    const items: WatchDashboardItem[] = catalog.watches().map((item) => {
      const state = watcher.state(item.value.id);
      const decision = state.decisions.findLast(
        (entry) => entry.status === "launched" && entry.runId,
      );
      const run = decision?.runId ? host.store.get(decision.runId) : undefined;
      let previousResultRun: WatchDashboardItem["previousResultRun"];
      if (run && run.result === undefined) {
        for (let index = state.decisions.length - 1; index >= 0; index--) {
          const previous = state.decisions[index];
          if (
            previous.status !== "launched" ||
            !previous.runId ||
            previous.runId === run.id
          )
            continue;
          const completed = host.store.get(previous.runId);
          if (
            completed.status === "completed" &&
            completed.result !== undefined
          ) {
            previousResultRun = {
              id: completed.id,
              updatedAt: completed.updatedAt,
              result: completed.result,
            };
            break;
          }
        }
      }
      return {
        ...item,
        state,
        previousResultRun,
        latestRun: run
          ? {
              id: run.id,
              status: run.status,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              error: run.error,
              result: run.result,
            }
          : undefined,
      };
    });
    response.json(items);
  });
  app.put("/api/pipeline-watches/:id", (request, response) => {
    const body = z
      .object({ value: watchSchema, revision: z.string().optional() })
      .parse(request.body);
    if (body.value.id !== request.params.id)
      throw Object.assign(new Error("Watch identity cannot change"), {
        status: 400,
      });
    watcher.validate(body.value);
    response.json(catalog.saveWatch(body.value, body.revision));
  });
  app.use("/api", (_request, response) =>
    response.status(404).json({ error: "API endpoint not found" }),
  );
  const client = path.resolve("dist/client");
  if (fs.existsSync(client)) {
    app.use(express.static(client));
    app.get("/{*path}", (_request, response) =>
      response.sendFile(path.join(client, "index.html")),
    );
  }
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      const message =
        error instanceof Error ? error.message : "Unexpected server error";
      const status =
        error !== null &&
        typeof error === "object" &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : 500;
      console.error(`[api] ${message}`);
      response.status(status).json({ error: message });
    },
  );
  return app;
}
