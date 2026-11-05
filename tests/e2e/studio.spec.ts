import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import type { QueueState, Run } from "../../shared/contracts.ts";
import { temporaryRoot, workflow } from "../helpers.ts";

const test = base.extend<{ instructionFile: string }>({
  instructionFile: async ({ browserName }, use) => {
    const root = temporaryRoot();
    const file = path.join(fs.realpathSync(root), `agent-${browserName}.md`);
    fs.writeFileSync(
      file,
      "# Agent\nCross-check claims against supplied evidence.",
    );
    try {
      await use(file);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
});

async function chooseInstructionFile(page: Page, file: string) {
  await page.getByRole("button", { name: "Choose Markdown file" }).click();
  const picker = page.getByRole("dialog", { name: "Choose Markdown file" });
  await expect(
    picker.getByRole("button", { name: "Parent directory" }),
  ).toBeVisible();
  await picker
    .getByLabel("Directory", { exact: true })
    .fill(path.dirname(file));
  await picker
    .getByRole("button", { name: "Open directory", exact: true })
    .click();
  await picker
    .getByRole("button", { name: path.basename(file), exact: true })
    .click();
}

test("workflow queue setting persists and launches appear in Queue history", async ({
  page,
}) => {
  const definition = workflow(`queue-ui-${crypto.randomUUID().slice(0, 8)}`);
  definition.name = `Queued browser workflow ${definition.id}`;
  const created = await page.request.put(`/api/pipelines/${definition.id}`, {
    data: { value: definition },
  });
  await expect(created).toBeOK();
  await page.goto(`/pipelines/${definition.id}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: "Queued", exact: true });
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(checkbox).toBeChecked();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("link", { name: "Run", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add to queue", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "context*", exact: true })
    .fill("Check shared scheduling.");
  await page.getByRole("button", { name: "Add to queue", exact: true }).click();
  await expect(page).toHaveURL(/\/runs\/run-/);
  const id = page.url().split("/").at(-1);
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/pipeline-runs/${id}`);
      const run: Run = await response.json();
      expect(run.queued).toBe(true);
      return run.status;
    })
    .toBe("completed");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Queue", exact: true })
    .click();
  const row = page
    .getByRole("region", { name: "Queue history" })
    .getByRole("link")
    .filter({ hasText: definition.name });
  await expect(row).toHaveAttribute("href", `/runs/${id}`);
  await expect(row).toContainText("completed");
  await expect(row).toContainText("Manual run");
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/runs/${id}$`));
  await page.goto(`/pipelines/${definition.id}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await checkbox.uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: false }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Run", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Run workflow", exact: true }),
  ).toBeVisible();
});

test("Queue history shows mixed statuses, polls updates and exposes empty and error states", async ({
  page,
}) => {
  let failed = false;
  const data: QueueState = {
    pending: 32,
    running: 1,
    runs: Array.from({ length: 30 }, (_, index) => ({
      id: `queue-history-${index}`,
      workflowId: `workflow-${index}`,
      workflowName: `Workflow ${index}`,
      queued: true,
      status: (
        ["queued", "running", "completed", "blocked", "cancelled"] as const
      )[index % 5],
      createdAt: "2026-11-05T17:00:00.000Z",
      updatedAt: "2026-11-05T17:00:00.000Z",
      requestId: `queue-${index}`,
      units: {},
      ...(index === 1
        ? {
            trigger: {
              watchId: "watch",
              eventId: "1",
              reason: "Scheduled check",
            },
          }
        : {}),
    })),
  };
  await page.route("**/api/queue", (route) =>
    failed
      ? route.fulfill({ status: 503, json: { error: "Queue unavailable" } })
      : route.fulfill({ json: data }),
  );
  await page.goto("/queue");
  const history = page.getByRole("region", { name: "Queue history" });
  await expect(history.getByRole("link")).toHaveCount(30);
  await expect(
    page.getByText("32 pending · 1 running", { exact: true }),
  ).toBeVisible();
  const first = history.getByRole("link").first();
  await expect(first).toHaveAttribute("href", "/runs/queue-history-0");
  await expect(first).toContainText("pending");
  await expect(history.getByRole("link").nth(1)).toContainText(
    "Watch: Scheduled check",
  );
  for (const status of ["running", "completed", "blocked", "cancelled"])
    await expect(
      history.getByText(status, { exact: true }).first(),
    ).toBeVisible();
  data.runs[0].status = "completed";
  await expect(first).toContainText("completed");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  data.runs = [];
  data.pending = 0;
  data.running = 0;
  await expect(
    page.getByText("Nothing queued yet", { exact: true }),
  ).toBeVisible();
  failed = true;
  await expect(page.getByRole("alert")).toHaveText("Queue unavailable");
});

test("show the latest 10 runs per workflow, refreshed independently by polling", async ({
  page,
}) => {
  let runs: Run[] = Array.from({ length: 26 }, (_, index) => {
    const workflowId =
      index >= 24
        ? "old-workflow"
        : index % 2 === 0
          ? "feature"
          : "pr-assistant";
    return {
      id: `run-history-${index}`,
      workflowId,
      workflowName:
        workflowId === "feature"
          ? "Feature development"
          : workflowId === "pr-assistant"
            ? index === 19
              ? "Old PR Assistant name"
              : "PR Assistant"
            : "Old workflow",
      status: index === 0 ? "running" : "completed",
      createdAt: new Date(Date.UTC(2026, 10, 4, 17, 30 - index)).toISOString(),
      updatedAt: "2026-11-04T17:30:00Z",
      requestId: `history-${index}`,
      units: {},
    };
  });
  await page.route("**/api/pipeline-runs", (route) =>
    route.fulfill({ json: runs }),
  );
  await page.goto("/runs");
  const history = page.getByRole("region", {
    name: "Recent runs",
    exact: true,
  });
  const feature = history.getByRole("region", {
    name: "Feature development",
    exact: true,
  });
  const assistant = history.getByRole("region", {
    name: "PR Assistant",
    exact: true,
  });
  const old = history.getByRole("region", {
    name: "Old workflow",
    exact: true,
  });
  await expect(history.getByRole("link")).toHaveCount(22);
  await expect(history.getByRole("heading", { level: 2 })).toHaveText([
    "Feature development",
    "PR Assistant",
    "Old workflow",
  ]);
  await expect(feature.getByRole("link")).toHaveCount(10);
  await expect(assistant.getByRole("link")).toHaveCount(10);
  await expect(old.getByRole("link")).toHaveCount(2);
  await expect(feature.getByRole("link").first()).toHaveAttribute(
    "href",
    "/runs/run-history-0",
  );
  await expect(feature.getByRole("link").last()).toHaveAttribute(
    "href",
    "/runs/run-history-18",
  );
  await expect(assistant.getByRole("link").last()).toHaveAttribute(
    "href",
    "/runs/run-history-19",
  );
  await expect(feature.getByText("running", { exact: true })).toBeVisible();
  await expect(history.locator('a[href="/runs/run-history-20"]')).toHaveCount(
    0,
  );
  await expect(history.locator('a[href="/runs/run-history-21"]')).toHaveCount(
    0,
  );
  runs = [
    {
      ...runs[1],
      id: "run-history-new",
      createdAt: "2026-11-04T17:31:00Z",
      updatedAt: "2026-11-04T17:31:00Z",
      trigger: {
        watchId: "watch-history",
        eventId: "new",
        reason: "Scheduled run",
      },
    },
    ...runs,
  ];
  await expect(assistant.getByRole("link").first()).toHaveAttribute(
    "href",
    "/runs/run-history-new",
  );
  await expect(history.getByRole("link")).toHaveCount(22);
  await expect(feature.getByRole("link")).toHaveCount(10);
  await expect(assistant.getByRole("link")).toHaveCount(10);
  await expect(old.getByRole("link")).toHaveCount(2);
  await expect(history.getByRole("heading", { level: 2 })).toHaveText([
    "PR Assistant",
    "Feature development",
    "Old workflow",
  ]);
  await expect(history.locator('a[href="/runs/run-history-19"]')).toHaveCount(
    0,
  );
  await expect(feature.getByRole("link").last()).toHaveAttribute(
    "href",
    "/runs/run-history-18",
  );
  await expect(assistant.getByRole("link").last()).toHaveAttribute(
    "href",
    "/runs/run-history-17",
  );
  await expect(
    assistant.getByText("Scheduled run", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(feature.getByRole("heading")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("run history keeps empty and API error states visible", async ({
  page,
}) => {
  let failed = false;
  await page.route("**/api/pipeline-runs", (route) =>
    failed
      ? route.fulfill({
          status: 503,
          json: { error: "Run history unavailable" },
        })
      : route.fulfill({ json: [] }),
  );
  await page.goto("/runs");
  await expect(
    page.getByRole("heading", { name: "No runs yet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Explore workflows" }),
  ).toHaveAttribute("href", "/pipelines");
  failed = true;
  await expect(page.getByRole("alert")).toHaveText("Run history unavailable");
});

test("configure a generic conditional loop and inspect immutable pass history and feedback", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const definition = workflow(`loop-${crypto.randomUUID().slice(0, 8)}`);
  definition.stages[0].agents = [definition.stages[0].agents[0]];
  definition.stages[1].outputSchema.properties = {
    summary: { type: "string" },
    count: { type: "number" },
  };
  definition.stages.push({
    ...definition.stages[1],
    id: "finish",
    name: "Finish",
    inputs: {
      evidence: {
        source: "stage",
        stageId: "report",
        agentId: "writer",
        pointer: "/summary",
      },
    },
  });
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  await page.goto(`/pipelines/${definition.id}`);
  await page.getByRole("button", { name: "02 Report", exact: true }).click();
  await page
    .getByRole("checkbox", {
      name: "Repeat earlier stages when a condition matches",
    })
    .check();
  await page
    .getByRole("combobox", { name: "Repeat from stage", exact: true })
    .selectOption("discover");
  await page
    .getByRole("combobox", { name: "Read output from", exact: true })
    .selectOption("writer");
  await page
    .getByRole("combobox", { name: "Output field", exact: true })
    .selectOption("/count");
  await page
    .getByRole("combobox", { name: "Comparison", exact: true })
    .selectOption("lessThan");
  await page
    .getByRole("textbox", { name: "Comparison value", exact: true })
    .fill("{");
  await expect(page.getByRole("alert")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Comparison value", exact: true })
    .fill("2");
  await page.getByLabel("Maximum total passes", { exact: true }).fill("2");
  const preview = page.getByRole("region", { name: "Loop preview" });
  await expect(preview).toContainText("If count is less than 2");
  await expect(preview.getByRole("listitem")).toHaveText([
    "Discover",
    "Report",
  ]);
  await expect(preview).toContainText("Continue to Finish");
  await expect(preview).toContainText("Still matches on pass 2?");
  await expect(
    page.getByRole("textbox", { name: "Loop feedback bindings", exact: true }),
  ).not.toBeVisible();
  await page.getByText("Feedback & advanced settings", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Loop feedback bindings", exact: true })
    .fill(
      JSON.stringify({
        notes: {
          source: "stage",
          stageId: "report",
          agentId: "writer",
          pointer: "/summary",
        },
      }),
    );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "02 Report", exact: true }).click();
  await expect(
    page.getByLabel("Maximum total passes", { exact: true }),
  ).toHaveValue("2");
  await expect(
    page.getByRole("combobox", { name: "Output field", exact: true }),
  ).toHaveValue("/count");
  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(
    page.getByText("Repeat: back to Discover", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Otherwise", { exact: true })).toBeVisible();
  const launched = await page.request.post(
    `/api/pipelines/${definition.id}/runs`,
    {
      data: {
        input: { context: "Synthetic loop; no external actions." },
        requestId: crypto.randomUUID(),
      },
    },
  );
  await expect(launched).toBeOK();
  const { id } = await launched.json();
  await page.goto(`/runs/${id}`);
  await expect(page.getByRole("alert")).toContainText(
    "maximum of 2 total passes",
  );
  const history = page.getByLabel("Report pass history", { exact: true });
  await expect(
    history.getByText("Pass 1 of up to 2 — Repeat from Discover", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    history.getByText("Pass 2 of up to 2 — Pass limit reached; blocked", {
      exact: true,
    }),
  ).toBeVisible();
  await history
    .getByText("Pass 1 of up to 2 — Repeat from Discover", { exact: true })
    .click();
  await expect(history.getByText(/"kind": "repeat"/)).toBeVisible();
  const firstHistory = page.getByLabel("Discover pass history", {
    exact: true,
  });
  await firstHistory.getByText("Pass 1 of up to 2", { exact: true }).click();
  await firstHistory
    .getByRole("button", { name: "View Alpha pass 1 (completed)", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Alpha", exact: true });
  await expect(
    dialog.getByRole("heading", { name: "Input", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/"feedback": null/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close activity details" }).click();
  await firstHistory.getByText("Pass 2 of up to 2", { exact: true }).click();
  await firstHistory
    .getByRole("button", { name: "View Alpha pass 2 (completed)", exact: true })
    .click();
  await expect(dialog.getByText(/"notes": "Fixture output/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close activity details" }).click();
  const before = await (
    await page.request.get(`/api/pipeline-runs/${id}`)
  ).json();
  expect(before.units["finish/writer"]).toBeUndefined();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "maximum of 2 total passes",
  );
  const after = await (
    await page.request.get(`/api/pipeline-runs/${id}`)
  ).json();
  expect(after.visits).toEqual(before.visits);
  expect(errors).toEqual([]);
});

test("edit loop conditions with typed values and custom paths without losing feedback", async ({
  page,
}) => {
  const definition = workflow(`loop-editor-${crypto.randomUUID().slice(0, 8)}`);
  const stage = definition.stages[1];
  stage.outputSchema.properties = {
    summary: { type: "string" },
    needsRevision: { type: "boolean" },
    details: { type: "object" },
  };
  stage.loop = {
    targetStageId: "discover",
    condition: {
      agentId: "writer",
      pointer: "/needsRevision",
      operator: "equals",
      value: true,
    },
    maxIterations: 3,
    feedback: {
      review: {
        source: "stage",
        stageId: "report",
        agentId: "writer",
        pointer: "",
      },
      context: {
        source: "stage",
        stageId: "discover",
        agentId: "alpha",
        pointer: "",
      },
    },
  };
  const created = await page.request.put(`/api/pipelines/${definition.id}`, {
    data: { value: definition },
  });
  await expect(created).toBeOK();
  const before = (await created.json()).value;
  await page.goto(`/pipelines/${definition.id}`);
  const edit = page.getByRole("button", {
    name: "Edit loop: Report",
    exact: true,
  });
  await expect(edit).toContainText("If needsRevision is true");
  await expect(edit).toContainText("Otherwise: finish workflow");
  await edit.click();
  const preview = page.getByRole("region", { name: "Loop preview" });
  await expect(preview).toContainText("If needsRevision is true");
  await expect(preview).toContainText("Finish the workflow");
  await expect(
    page.getByRole("combobox", { name: "Comparison value", exact: true }),
  ).toHaveValue("true");
  await expect(
    page.getByText("review, context", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Loop feedback bindings" }),
  ).not.toBeVisible();
  async function save() {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText("All changes saved", { exact: false }),
    ).toBeVisible();
    return (
      await (await page.request.get(`/api/pipelines/${definition.id}`)).json()
    ).value;
  }
  expect(await save()).toEqual(before);
  await edit.click();
  await page
    .getByRole("combobox", { name: "Comparison value", exact: true })
    .selectOption("false");
  await expect(preview).toContainText("If needsRevision is false");
  let saved = await save();
  expect(saved.stages[1].loop.condition.value).toBe(false);
  expect(saved.stages[1].loop.feedback).toEqual(stage.loop.feedback);

  await edit.click();
  await page
    .getByRole("combobox", { name: "Output field", exact: true })
    .selectOption("custom");
  await page
    .getByRole("textbox", { name: "Custom field path", exact: true })
    .fill("/details/status");
  await page
    .getByRole("combobox", { name: "Value type", exact: true })
    .selectOption("string");
  await page
    .getByRole("textbox", { name: "Comparison value", exact: true })
    .fill("true");
  await expect(preview).toContainText('If details/status is "true"');
  saved = await save();
  expect(saved.stages[1].loop.condition).toEqual({
    agentId: "writer",
    pointer: "/details/status",
    operator: "equals",
    value: "true",
  });
  expect(saved.stages[1].loop.feedback).toEqual(stage.loop.feedback);
  await page.reload();
  await edit.click();
  await expect(
    page.getByRole("textbox", { name: "Custom field path", exact: true }),
  ).toHaveValue("/details/status");
  await page
    .getByRole("combobox", { name: "Value type", exact: true })
    .selectOption("json");
  await page
    .getByRole("textbox", { name: "Comparison value", exact: true })
    .fill('{"ready":true}');
  saved = await save();
  expect(saved.stages[1].loop.condition.value).toEqual({ ready: true });
  expect(saved.stages[1].loop.feedback).toEqual(stage.loop.feedback);

  await edit.click();
  await page
    .getByRole("textbox", { name: "Comparison value", exact: true })
    .fill("{");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("invalid fields");
  expect(
    (await (await page.request.get(`/api/pipelines/${definition.id}`)).json())
      .value,
  ).toEqual(saved);
  await page
    .getByRole("combobox", { name: "Comparison", exact: true })
    .selectOption("notEquals");
  await expect(
    page.getByRole("textbox", { name: "Comparison value", exact: true }),
  ).toHaveValue(JSON.stringify({ ready: true }, null, 2));
  saved = await save();
  expect(saved.stages[1].loop.condition.value).toEqual({ ready: true });
  expect(saved.stages[1].loop.condition.operator).toBe("notEquals");
  await edit.click();
  await page
    .getByRole("textbox", { name: "Comparison value", exact: true })
    .fill("{");
  await page
    .getByRole("checkbox", {
      name: "Repeat earlier stages when a condition matches",
    })
    .uncheck();
  await expect(page.getByRole("alert")).not.toBeVisible();
  await expect(preview).not.toBeVisible();
  await expect(edit).not.toBeVisible();
  await expect(
    page.getByText("Repeat: back to Discover", { exact: true }),
  ).not.toBeVisible();
  saved = await save();
  expect(saved.stages[1].loop).toBeUndefined();
});

test("keep the full loop visible when loading a long workflow and opening its editor", async ({
  page,
}) => {
  const definition = workflow(`loop-canvas-${crypto.randomUUID().slice(0, 8)}`);
  for (let step = 3; step <= 7; step++) {
    definition.stages.push({
      ...definition.stages[1],
      id: `step-${step}`,
      name: `Stage ${step}`,
    });
  }
  definition.stages[6].loop = {
    targetStageId: "discover",
    condition: {
      agentId: "writer",
      pointer: "/summary",
      operator: "equals",
      value: "repeat",
    },
    maxIterations: 3,
    feedback: {},
  };
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  await page.goto(`/pipelines/${definition.id}`);
  const first = page.getByRole("group", {
    name: "Discover stage",
    exact: true,
  });
  const last = page.getByRole("group", { name: "Stage 7 stage", exact: true });
  await expect(first).toBeInViewport({ ratio: 0.99 });
  await expect(last).toBeInViewport({ ratio: 0.99 });
  await page
    .getByRole("button", { name: "Edit loop: Stage 7", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Loop preview" }),
  ).toContainText('If summary is "repeat"');
  await expect(first).toBeInViewport({ ratio: 0.99 });
  await expect(last).toBeInViewport({ ratio: 0.99 });
});

test("choose linked Markdown files independently for agents and show browse/save errors", async ({
  page,
  instructionFile,
}) => {
  const directory = path.dirname(instructionFile);
  const filename = path.basename(instructionFile);
  fs.mkdirSync(path.join(directory, "nested"));
  fs.writeFileSync(
    path.join(directory, "ignore.txt"),
    "Not an instruction file.",
  );
  const definition = workflow(
    `instruction-files-${crypto.randomUUID().slice(0, 8)}`,
  );
  const missingFile = path.join(directory, "missing.md");
  fs.writeFileSync(missingFile, "# Instructions\nThis file will be removed.");
  definition.stages[0].agents[0].instructionsFile = missingFile;
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  fs.unlinkSync(missingFile);
  await page.goto(`/pipelines/${definition.id}`);
  await page.getByRole("button", { name: "Alpha Backend default" }).click();
  const file = page.getByRole("status", { name: "Agent instructions file" });
  await expect(
    page.getByRole("textbox", { name: "Agent instructions file" }),
  ).toHaveCount(0);
  await expect(file).toHaveText("missing.md");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Cannot read instructions file",
  );
  await page.getByRole("button", { name: "Choose Markdown file" }).click();
  const picker = page.getByRole("dialog", { name: "Choose Markdown file" });
  await expect(
    picker.getByRole("button", { name: filename, exact: true }),
  ).toBeVisible();
  await expect(
    picker.getByRole("button", { name: "ignore.txt", exact: true }),
  ).toHaveCount(0);
  await picker.getByLabel("Directory", { exact: true }).fill("relative/path");
  await picker
    .getByRole("button", { name: "Open directory", exact: true })
    .click();
  await expect(picker.getByRole("alert")).toContainText("absolute path");
  await picker.getByLabel("Directory", { exact: true }).fill(directory);
  await picker
    .getByRole("button", { name: "Open directory", exact: true })
    .click();
  await picker.getByRole("button", { name: "nested/", exact: true }).click();
  await expect(
    picker.getByText("No directories or Markdown files."),
  ).toBeVisible();
  await picker.getByRole("button", { name: "Parent directory" }).click();
  await picker.getByRole("button", { name: filename, exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(file).toHaveText(filename);
  await page.getByRole("button", { name: "Beta Backend default" }).click();
  await expect(file).toHaveText("No file selected");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Alpha Backend default" }).click();
  await expect(file).toHaveText(filename);
  const saved = await (
    await page.request.get(`/api/pipelines/${definition.id}`)
  ).json();
  expect(saved.value.stages[0].agents[0].instructionsFile).toBe(
    instructionFile,
  );
  expect(saved.value.stages[0].agents[0].instructions).toBe("");
  expect(saved.value.stages[0].agents[1].instructionsFile).toBeUndefined();
  await page.getByRole("button", { name: "Choose Markdown file" }).click();
  await expect(picker).toBeVisible();
  await picker.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(file).toBeVisible();
});

test("instruction filenames stay below their label and truncate without hiding the picker", async ({
  page,
  instructionFile,
}) => {
  const filename = `${"long-agent-instructions-".repeat(8)}chromium.md`;
  const longFile = path.join(path.dirname(instructionFile), filename);
  fs.renameSync(instructionFile, longFile);
  const definition = workflow(
    `instruction-layout-${crypto.randomUUID().slice(0, 8)}`,
  );
  definition.stages[0].agents[0].instructionsFile = longFile;
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  await page.goto(`/pipelines/${definition.id}`);
  await page.getByRole("button", { name: "Alpha Backend default" }).click();
  const file = page.getByRole("status", { name: "Agent instructions file" });
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(file).toHaveText(filename);
    await expect(file).toHaveAttribute("title", longFile);
    const layout = await file.evaluate((element) => {
      const field = element.closest(".field")!;
      const label = field.querySelector("span")!.getBoundingClientRect();
      const name = element.getBoundingClientRect();
      const picker = field.querySelector("button")!.getBoundingClientRect();
      return {
        belowLabel: name.top >= label.bottom,
        truncated: element.scrollWidth > element.clientWidth,
        pickerFits:
          picker.left >= name.right &&
          picker.right <= field.getBoundingClientRect().right,
      };
    });
    expect(layout).toEqual({
      belowLabel: true,
      truncated: true,
      pickerFits: true,
    });
    await page.getByRole("button", { name: "Choose Markdown file" }).click();
    const picker = page.getByRole("dialog", { name: "Choose Markdown file" });
    await expect(picker).toBeVisible();
    await picker.press("Escape");
  }
});

test("completed runs download a ZIP and show download errors without leaving the run", async ({
  page,
}) => {
  const definition = workflow(`download-${crypto.randomUUID().slice(0, 8)}`);
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  const launched = await page.request.post(
    `/api/pipelines/${definition.id}/runs`,
    {
      data: {
        input: { context: "Download completed run assets." },
        requestId: crypto.randomUUID(),
      },
    },
  );
  await expect(launched).toBeOK();
  const run = await launched.json();
  await page.goto(`/runs/${run.id}`);
  const button = page.getByRole("button", { name: "Download assets" });
  await expect(button).toBeVisible();
  const endpoint = `**/api/pipeline-runs/${run.id}/assets`;
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 409,
      json: { error: "Published report changed since this run completed." },
    }),
  );
  await button.click();
  await expect(page.getByRole("alert")).toContainText(
    "Published report changed",
  );
  await expect(page).toHaveURL(new RegExp(`/runs/${run.id}$`));
  await expect(button).toBeEnabled();
  await page.unroute(endpoint);
  const downloading = page.waitForEvent("download");
  await button.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`${run.id}-assets.zip`);
  expect(await download.failure()).toBeNull();
  const file = await download.path();
  if (!file) throw new Error("Download file is missing.");
  const archive = unzipSync(fs.readFileSync(file));
  expect(archive["execution/snapshot.json"]).toBeDefined();
  expect(strFromU8(archive["execution/result.json"])).toContain(
    "Fixture output - automated testing only",
  );
  await expect(page.getByRole("alert")).not.toBeVisible();
});

test("a blocked outcome stops execution and leaves later stages unexecuted", async ({
  page,
}) => {
  const definition = workflow(
    `blocked-outcome-${crypto.randomUUID().slice(0, 8)}`,
  );
  definition.stages[0].outputSchema.properties = {
    summary: { type: "string" },
    status: { type: "string", enum: ["blocked"] },
  };
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  const launched = await page.request.post(
    `/api/pipelines/${definition.id}/runs`,
    {
      data: {
        input: { context: "Do not advance past a business blocker." },
        requestId: crypto.randomUUID(),
      },
    },
  );
  await expect(launched).toBeOK();
  const run = await launched.json();
  await page.goto(`/runs/${run.id}`);
  await expect(page.getByRole("alert")).toContainText(
    'reported status "blocked"',
  );
  await expect(
    page.getByRole("button", { name: "Download assets" }),
  ).toHaveCount(0);
  const discover = page.getByRole("region", { name: "Discover stage" });
  await expect(discover).toHaveAccessibleDescription("Executed");
  await expect(
    discover.getByRole("button", { name: "View Alpha input and output" }),
  ).toContainText("blocked");
  await expect(
    discover.getByRole("button", { name: "Rerun from Discover" }),
  ).toBeEnabled();
  await expect(
    discover.getByRole("button", { name: "Restart from Discover" }),
  ).toBeEnabled();
  const report = page.getByRole("region", { name: "Report stage" });
  await expect(report).toHaveAccessibleDescription("Not executed");
  await expect(
    report.getByRole("button", { name: "View Writer input and output" }),
  ).toHaveCount(0);
  await expect(
    report.getByRole("button", { name: "Rerun from Report" }),
  ).toBeDisabled();
  await expect(
    report.getByRole("button", { name: "Restart from Report" }),
  ).toBeDisabled();
  const stored = await (
    await page.request.get(`/api/pipeline-runs/${run.id}`)
  ).json();
  expect(stored.status).toBe("blocked");
  expect(stored.currentStage).toBe("discover");
  expect(stored.units["@schema/report"]).toBeUndefined();
  expect(stored.units["report/writer"]).toBeUndefined();
  expect(stored.result).toBeUndefined();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Latest compatible instructions");
    await dialog.accept();
  });
  const restarting = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`/pipeline-runs/${run.id}/rerun`),
  );
  await discover.getByRole("button", { name: "Restart from Discover" }).click();
  expect((await restarting).postDataJSON()).toMatchObject({
    stageId: "discover",
    latestInstructions: true,
  });
  await expect(page).not.toHaveURL(new RegExp(`/runs/${run.id}$`));
  await expect(page.getByRole("alert")).toContainText(
    'reported status "blocked"',
  );
});

test("saving prevents inspector and canvas edits from being silently discarded", async ({
  page,
  instructionFile,
}) => {
  const definition = workflow(`saving-${crypto.randomUUID().slice(0, 8)}`);
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  await page.goto(`/pipelines/${definition.id}`);
  await page.getByRole("button", { name: "Alpha Backend default" }).click();
  const instructions = page.getByRole("button", {
    name: "Choose Markdown file",
  });
  await chooseInstructionFile(page, instructionFile);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(`**/api/pipelines/${definition.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      started.resolve();
      await release.promise;
    }
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await started.promise;
    await expect(instructions).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Add stage", exact: true }),
    ).toBeDisabled();
  } finally {
    release.resolve();
  }
  await expect(
    page.getByText("All changes saved", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Alpha Backend default" }).click();
  await expect(instructions).toBeEnabled();
  await expect(
    page.getByRole("status", { name: "Agent instructions file" }),
  ).toHaveText(path.basename(instructionFile));
});

test("configure independent agent folders, persist them, and launch with restricted tools", async ({
  page,
}) => {
  const root = temporaryRoot();
  const folder = path.join(root, "project with spaces");
  const otherFolder = path.join(root, "another project");
  fs.mkdirSync(folder);
  fs.mkdirSync(otherFolder);
  const alphaFolders = [
    fs.realpathSync(folder),
    fs.realpathSync(otherFolder),
  ].sort();
  const betaFolders = [fs.realpathSync(otherFolder)];
  const definition = workflow(
    `folder-access-${crypto.randomUUID().slice(0, 8)}`,
  );
  try {
    const saved = await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    });
    await expect(saved).toBeOK();
    await page.goto(`/pipelines/${definition.id}`);
    await page.getByRole("button", { name: "Alpha Backend default" }).click();
    const folders = page.getByRole("textbox", { name: /^Allowed folders/ });
    await expect(folders).toBeEmpty();
    await folders.fill("relative/project");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "must be an absolute path",
    );
    await folders.fill(folder);
    await folders.press("End");
    await folders.press("Enter");
    await expect(folders).toHaveValue(`${folder}\n`);
    await folders.fill(`${folder}\n${otherFolder}\n${folder}`);
    await page.getByRole("button", { name: "Beta Backend default" }).click();
    await expect(folders).toBeEmpty();
    await folders.fill(otherFolder);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText("All changes saved", { exact: false }),
    ).toBeVisible();
    const stored = await (
      await page.request.get(`/api/pipelines/${definition.id}`)
    ).json();
    expect(stored.value.stages[0].agents[0].allowedFolders).toEqual(
      alphaFolders,
    );
    expect(stored.value.stages[0].agents[1].allowedFolders).toEqual(
      betaFolders,
    );
    expect(stored.value.stages[1].agents[0].allowedFolders).toBeUndefined();
    await page.reload();
    await page.getByRole("button", { name: "Alpha Backend default" }).click();
    await expect(folders).toHaveValue(alphaFolders.join("\n"));
    await page.getByRole("button", { name: "Beta Backend default" }).click();
    await expect(folders).toHaveValue(betaFolders.join("\n"));
    await page.getByRole("button", { name: "Close inspector" }).click();
    await page.getByRole("link", { name: "Run", exact: true }).click();
    await expect(folders).toHaveCount(0);
    await page
      .getByLabel("Context", { exact: false })
      .fill("Inspect the allowed project.");
    await expect(
      page.getByRole("checkbox", { name: "Allow all tools" }),
    ).not.toBeChecked();
    await page.getByRole("button", { name: "Run workflow" }).click();
    await expect(page).toHaveURL(/\/runs\/run-/);
    const runId = page.url().split("/").at(-1);
    const run = await (
      await page.request.get(`/api/pipeline-runs/${runId}`)
    ).json();
    expect(run.allowedFolders).toBeUndefined();
    expect(run.allowAllTools).toBe(false);
    const result = page.getByRole("region", { name: "Result", exact: true });
    await expect(result).toContainText(
      "This is a fixture-generated result summary.",
    );
    await expect(result.locator(".result-panel")).not.toBeVisible();
    await page
      .getByRole("button", { name: "View Beta input and output" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Beta" });
    const input = dialog.getByRole("region", { name: "Input", exact: true });
    await expect(input).toContainText(betaFolders[0]);
    await expect(input).not.toContainText(fs.realpathSync(folder));
    await dialog
      .getByRole("button", { name: "Close activity details" })
      .click();
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("delete a workflow only after confirmation and remove it from the gallery", async ({
  page,
}) => {
  await page.goto("/pipelines/new");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Disposable workflow");
  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(
    page.getByRole("button", { name: "Delete", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines\/workflow-/);
  const url = page.url();
  const id = url.split("/").at(-1);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain('Delete "Disposable workflow"?');
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(url);
  expect((await page.request.get(`/api/pipelines/${id}`)).status()).toBe(200);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/pipelines$/);
  await expect(
    page.getByText("Disposable workflow", { exact: true }),
  ).not.toBeVisible();
  expect((await page.request.get(`/api/pipelines/${id}`)).status()).toBe(404);
});

test("build, configure agents, save, reload, and run a user-composed workflow", async ({
  page,
  instructionFile,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/pipelines/new");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Browser triage");
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "01 New stage", exact: true }).click();
  await page.getByLabel("Stage name").fill("Understand");
  await page
    .getByLabel("Stage instructions")
    .fill("Analyze supplied evidence without assuming missing facts.");
  await page.getByRole("button", { name: "Add agent", exact: true }).click();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "New agent Backend default" }).click();
  await page.getByLabel("Agent name").fill("Second perspective");
  await chooseInstructionFile(page, instructionFile);
  await page.getByRole("button", { name: "Close inspector" }).click();
  const card = page.getByRole("group", {
    name: "Understand stage",
    exact: true,
  });
  await card.dragTo(card, {
    sourcePosition: { x: 10, y: 10 },
    targetPosition: { x: 110, y: 90 },
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: false }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/pipelines\/workflow-/);
  const workflowId = page.url().split("/").at(-1);
  const savedResponse = await page.request.get(`/api/pipelines/${workflowId}`);
  const saved = await savedResponse.json();
  expect(Object.keys(saved.value.layout)).toHaveLength(1);
  const persistedLayout = saved.value.layout;
  await page.reload();
  expect(
    (await (await page.request.get(`/api/pipelines/${workflowId}`)).json())
      .value.layout,
  ).toEqual(persistedLayout);
  await expect(
    page.getByRole("heading", { name: "Browser triage" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Second perspective Backend default" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Run", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Allow all tools" }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Allow all tools" }).check();
  await page
    .getByLabel("Context", { exact: false })
    .fill(
      "An issue appears after a recent change. Investigate only supplied evidence.",
    );
  await page.getByRole("button", { name: "Run workflow" }).click();
  await expect(page).toHaveURL(/\/runs\/run-/);
  await expect(page.getByText(/All tools allowed/)).toBeVisible();
  const runId = page.url().split("/").at(-1);
  expect(
    (await (await page.request.get(`/api/pipeline-runs/${runId}`)).json())
      .allowAllTools,
  ).toBe(true);
  const result = page.getByRole("region", { name: "Result", exact: true });
  await expect(result).toContainText(
    "This is a fixture-generated result summary.",
  );
  await expect(result.locator(".result-panel")).not.toBeVisible();
  await result.getByText("Raw output", { exact: true }).click();
  await expect(result.locator(".result-panel")).toContainText(
    "Fixture output - automated testing only",
  );
  await result.getByText("Raw output", { exact: true }).click();
  await expect(result.locator(".result-panel")).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Browser triage" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Understand contract" }),
  ).toHaveText("Understand contract");
  await expect(
    page.getByRole("button", {
      name: "View Understand contract input and output",
    }),
  ).toHaveCount(0);
  const agentCard = page.getByRole("button", {
    name: "View Second perspective input and output",
  });
  await agentCard.focus();
  await page.keyboard.press("Enter");
  const agentDialog = page.getByRole("dialog", { name: "Second perspective" });
  await expect(agentDialog).toBeVisible();
  await expect(
    agentDialog.getByRole("region", { name: "Input", exact: true }),
  ).toContainText("An issue appears after a recent change.");
  await expect(
    agentDialog.getByRole("region", { name: "Input", exact: true }),
  ).toContainText("Cross-check claims against supplied evidence.");
  await expect(
    agentDialog.getByRole("region", { name: "Input", exact: true }),
  ).toContainText("Analyze supplied evidence without assuming missing facts.");
  await expect(
    agentDialog.getByRole("region", { name: "Output", exact: true }),
  ).toContainText("Fixture output - automated testing only");
  await agentDialog
    .getByRole("button", { name: "Close activity details" })
    .click();
  await expect(agentDialog).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("clearing optional numeric and enum inputs removes the previously selected values", async ({
  page,
}) => {
  await page.request.put("/api/pipelines/form-clear", {
    data: {
      value: {
        id: "form-clear",
        name: "Input clearing",
        inputSchema: {
          type: "object",
          properties: {
            count: { type: "number" },
            mode: { type: "string", enum: ["small", "large"] },
          },
        },
        stages: [
          {
            id: "analyze",
            name: "Analyze",
            outputSchema: {
              type: "object",
              properties: { summary: { type: "string" } },
            },
            agents: [{ id: "agent", name: "Agent" }],
          },
        ],
      },
    },
  });
  let submitted: unknown;
  await page.route("**/api/pipelines/form-clear/runs", async (route) => {
    submitted = route.request().postDataJSON().input;
    await route.continue();
  });
  await page.goto("/pipelines/form-clear/run");
  await page.getByLabel("count").fill("7");
  await page.getByLabel("count").clear();
  await page.getByRole("combobox", { name: "mode" }).selectOption('"large"');
  await page.getByRole("combobox", { name: "mode" }).selectOption("");
  await page.getByRole("button", { name: "Run workflow" }).click();
  await expect(page).toHaveURL(/\/runs\/run-/);
  expect(submitted).toEqual({});
  const runId = page.url().split("/").at(-1);
  expect(
    (await (await page.request.get(`/api/pipeline-runs/${runId}`)).json())
      .allowAllTools,
  ).toBe(false);
});

test("invalid JSON remains visible and cannot silently save an older value", async ({
  page,
}) => {
  await page.goto("/pipelines/new");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Launch input schema").fill("{invalid");
  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(page.getByLabel("Launch input schema")).toHaveValue("{invalid");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("invalid fields");
  await page.getByLabel("Launch input schema").fill('{"type":"object"}');
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: false }),
  ).toBeVisible();
});

test("import a reusable Markdown skill and register, pause, and edit a watch", async ({
  page,
}) => {
  await page.goto("/skills");
  await page.getByRole("button", { name: "New skill" }).click();
  await page.getByLabel("Skill name").fill("Evidence standards");
  await page.getByLabel("Import Markdown").setInputFiles({
    name: "evidence.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Evidence\nSeparate observations from assumptions."),
  });
  await expect(page.getByLabel("Markdown instructions")).toHaveValue(
    "# Evidence\nSeparate observations from assumptions.",
  );
  await page.getByRole("button", { name: "Save skill" }).click();
  await expect(
    page.getByRole("button", { name: /Evidence standards/ }),
  ).toBeVisible();
  await page.goto("/watches");
  await page.getByRole("button", { name: "New watch" }).click();
  await page.getByLabel("Watch name").fill("Daily triage");
  await expect(
    page.getByRole("checkbox", { name: "Allow all tools for scheduled runs" }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Allow all tools for scheduled runs" })
    .check();
  await page
    .getByRole("combobox", { name: "Workflow", exact: true })
    .selectOption({ label: "Bug triage" });
  await page
    .getByLabel("Workflow input bindings")
    .fill('{"context":{"source":"literal","value":"Recurring bug context"}}');
  await page.getByRole("button", { name: "Save watch" }).click();
  await expect(
    page.getByRole("button", { name: "Daily triage", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause Daily triage" }).click();
  await expect(
    page.getByRole("button", { name: "Enable Daily triage" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Daily triage", exact: true }).click();
  await expect(page.getByLabel("Cron expression")).toHaveValue("0 9 * * 1-5");
  await expect(
    page.getByRole("checkbox", { name: "Allow all tools for scheduled runs" }),
  ).toBeChecked();
  await page
    .getByRole("checkbox", { name: "Allow all tools for scheduled runs" })
    .uncheck();
  await page.getByRole("button", { name: "Save watch" }).click();
  await page.getByRole("button", { name: "Daily triage", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Allow all tools for scheduled runs" }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Close watch editor" }).click();
});
