import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import type {
  QueueState,
  Run,
  RunDetails,
  RunSummary,
} from "../../shared/contracts.ts";
import { temporaryRoot, workflow } from "../helpers.ts";
import telemetryInputSchema from "../fixtures/telemetry-input-schema.json" with { type: "json" };

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

test("single-step actions have their own searchable collection and overview group", async ({
  page,
}) => {
  const assigned = workflow("assigned-prs");
  assigned.name = "PR inbox";
  assigned.description = "PRs assigned to me";
  assigned.stages = [assigned.stages[0]];
  const comments = structuredClone(assigned);
  comments.id = "pr-comments";
  comments.name = "Comment pulse";
  comments.description = "PR open comment count";
  const process = workflow("review-process");
  process.name = "Review and report";
  const loop = structuredClone(assigned);
  loop.id = "retry-check";
  loop.name = "Check until ready";
  loop.stages[0].loop = {
    targetStageId: loop.stages[0].id,
    condition: {
      agentId: loop.stages[0].agents[0].id,
      pointer: "/summary",
      operator: "equals",
      value: "retry",
    },
    maxIterations: 3,
    feedback: {},
  };
  await page.route("**/api/pipelines", (route) =>
    route.fulfill({
      json: [assigned, comments, process, loop].map((value) => ({
        value,
        revision: value.id,
      })),
    }),
  );
  await page.goto("/pipelines");
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link").filter({ hasText: process.name }),
  ).toBeVisible();
  await expect(
    page.getByRole("link").filter({ hasText: loop.name }),
  ).toBeVisible();
  await expect(
    page.getByRole("link").filter({ hasText: assigned.name }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Actions", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Actions", exact: true }),
  ).toBeVisible();
  const inbox = page.getByRole("link").filter({ hasText: assigned.name });
  await expect(inbox).toHaveAttribute("href", "/actions/assigned-prs");
  await expect(inbox).toContainText("Single step");
  await expect(
    page.getByRole("link").filter({ hasText: process.name }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link").filter({ hasText: loop.name }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Search actions" })
    .fill("comment count");
  await expect(
    page.getByRole("link").filter({ hasText: comments.name }),
  ).toBeVisible();
  await expect(inbox).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Search actions" })
    .fill("no matching task");
  await expect(
    page.getByText("Your next small win", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Overview", exact: true })
    .click();
  const workflows = page.getByRole("region", {
    name: "Your workflows",
    exact: true,
  });
  const actions = page.getByRole("region", {
    name: "Your actions",
    exact: true,
  });
  await expect(
    workflows.getByRole("heading", { name: process.name }),
  ).toBeVisible();
  await expect(
    workflows.getByRole("heading", { name: assigned.name }),
  ).toHaveCount(0);
  await expect(
    actions.getByRole("heading", { name: assigned.name }),
  ).toBeVisible();
  await expect(
    actions.getByRole("heading", { name: process.name }),
  ).toHaveCount(0);
});

test("actions can be created, run and expanded into workflows without changing their identity", async ({
  page,
}) => {
  await page.goto("/actions");
  await page.getByRole("link", { name: "New action", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Untitled action" }),
  ).toBeVisible();
  await expect(page.getByRole("application")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Expected input", exact: false }),
  ).toHaveValue("A required Context text field describing what to do.");
  await expect(
    page.getByRole("textbox", { name: "Input schema", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Expected output", exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Output schema", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Upload Markdown", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const name = `PR inbox ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/actions\/workflow-/);
  const id = page.url().split("/").at(-1)!;
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Run", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Back to action", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Context", exact: false })
    .fill("Check my assigned PRs.");
  await page.getByRole("button", { name: "Run action", exact: true }).click();
  await expect(page).toHaveURL(/\/runs\/run-/);
  await page.goto(`/actions/${id}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Convert to workflow", exact: true })
    .click();
  await expect(page.getByRole("application")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(`/pipelines/${id}`);
  await page
    .getByRole("link", { name: "Back to workflows", exact: true })
    .click();
  await expect(page.getByRole("link").filter({ hasText: name })).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Actions", exact: true })
    .click();
  await expect(page.getByRole("link").filter({ hasText: name })).toHaveCount(0);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Workflows", exact: true })
    .click();
  await page.getByRole("link", { name: "New workflow", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Untitled workflow" }),
  ).toBeVisible();
  await expect(page.getByText("2 stages", { exact: false })).toBeVisible();
});

test("the action editor saves expected output and uploaded Markdown while preserving existing action settings", async ({
  page,
  instructionFile,
}) => {
  const definition = workflow(
    `action-editor-${crypto.randomUUID().slice(0, 8)}`,
  );
  definition.stages = [definition.stages[0]];
  definition.stages[0].agents = [definition.stages[0].agents[0]];
  definition.stages[0].agents[0].instructionsFile = instructionFile;
  definition.inputSchema = {
    ...definition.inputSchema,
    properties: {
      context: { type: "string", title: "PR context" },
      prUrl: { type: "string", title: "PR URL" },
    },
  };
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  await page.goto(`/actions/${definition.id}`);
  await expect(page.getByRole("application")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add stage", exact: true }),
  ).toHaveCount(0);
  const file = page.getByRole("status", { name: "Agent instructions file" });
  await expect(file).toHaveText(path.basename(instructionFile));
  const expectedInput =
    "A required PR context text field and an optional PR URL text field.";
  const expectedOutput =
    "Return a short summary and the number of open comments.";
  const input = page.getByRole("textbox", {
    name: "Expected input",
    exact: false,
  });
  await expect(input).toBeEmpty();
  await input.fill(expectedInput);
  await page
    .getByRole("textbox", { name: "Expected output", exact: false })
    .fill(expectedOutput);
  const upload = page.getByLabel("Upload Markdown", { exact: true });
  for (const [name, content, message] of [
    ["instructions.txt", "Not Markdown", "Choose a Markdown (.md) file."],
    ["instructions.md", " \n ", "Markdown instructions cannot be empty."],
    ["instructions.md", "a".repeat(50001), "cannot exceed 50,000 characters"],
  ]) {
    await upload.setInputFiles({
      name,
      mimeType: "text/markdown",
      buffer: Buffer.from(content),
    });
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(file).toHaveText(path.basename(instructionFile));
  }
  const instructions =
    "# PR inbox\nCount open PR comments and return evidence.";
  await upload.setInputFiles({
    name: "pr-inbox.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(instructions),
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByText("View saved instructions", { exact: true }).click();
  await expect(page.getByText(instructions, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue(expectedInput);
  await expect(
    page.getByRole("textbox", { name: "Expected output", exact: false }),
  ).toHaveValue(expectedOutput);
  await page.getByText("View saved instructions", { exact: true }).click();
  await expect(page.getByText(instructions, { exact: true })).toBeVisible();
  const saved = await (
    await page.request.get(`/api/pipelines/${definition.id}`)
  ).json();
  expect(saved.value.expectedInput).toBe(expectedInput);
  expect(saved.value.inputSchema).toEqual(definition.inputSchema);
  expect(saved.value.stages[0]).toEqual({
    ...definition.stages[0],
    expectedOutput,
    inputs: {},
    agents: [
      {
        ...definition.stages[0].agents[0],
        instructionsFile: undefined,
        instructions,
      },
    ],
  });
  await page.getByRole("link", { name: "Run", exact: true }).click();
  await page
    .getByRole("textbox", { name: "PR context", exact: false })
    .fill("Check my assigned PRs.");
  await page.getByRole("button", { name: "Run action", exact: true }).click();
  await expect(page).toHaveURL(/\/runs\/run-/);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/pipeline-runs/${page.url().split("/").at(-1)}`,
      );
      return (await response.json()).status;
    })
    .toBe("completed");
});

test("invalid telemetry inputs stay on the launch form without creating a run", async ({
  page,
}) => {
  const definition = workflow(`input-ui-${crypto.randomUUID().slice(0, 8)}`);
  definition.inputSchema = telemetryInputSchema;
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  await page.goto(`/pipelines/${definition.id}`);
  await page.getByRole("link", { name: "Run", exact: true }).click();
  await page
    .getByLabel("context", { exact: false })
    .fill("Investigate code paths.");
  const start = page.getByRole("textbox", {
    name: "Telemetry start (UTC)",
    exact: true,
  });
  const end = page.getByRole("textbox", {
    name: "Telemetry end (UTC)",
    exact: true,
  });
  await start.fill("Ignore telemetry");
  await end.fill("Ignore telemetry");
  let submissions = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/pipelines/${definition.id}/runs`)
    )
      submissions++;
  });
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText('format "date-time"');
  expect(submissions).toBe(0);
  const invalid = await page.request.post(
    `/api/pipelines/${definition.id}/runs`,
    {
      data: {
        input: {
          context: "Invalid API input",
          telemetryStartUtc: "Ignore telemetry",
        },
        requestId: crypto.randomUUID(),
      },
    },
  );
  expect(invalid.status()).toBe(400);
  await start.fill("2026-11-09T07:00:00Z");
  await end.fill("2026-11-09T06:00:00Z");
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("should be >");
  expect(submissions).toBe(0);
  await start.fill("");
  await end.fill("");
  await page
    .getByLabel("Scope hints", { exact: true })
    .fill("No Kusto required.");
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect(page).toHaveURL(/\/runs\/run-/);
  expect(submissions).toBe(1);
});

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

test("workflow and action run histories stay separate and details return to the correct history", async ({
  page,
}) => {
  const workflowRun: RunSummary = {
    id: "run-separate-workflow",
    workflowId: "changing-definition",
    workflowName: "Original workflow",
    kind: "workflow",
    status: "completed",
    createdAt: "2026-11-10T12:00:00Z",
    updatedAt: "2026-11-10T12:00:00Z",
    requestId: "separate-workflow",
    units: {},
  };
  const actionRun: RunSummary = {
    ...workflowRun,
    id: "run-separate-action",
    workflowName: "Focused action",
    kind: "action",
    requestId: "separate-action",
    trigger: {
      watchId: "comment-watch",
      eventId: "comments",
      reason: "New review comments",
    },
  };
  let runs = [actionRun, workflowRun];
  const detail: RunDetails = {
    ...actionRun,
    stages: [],
    result: { status: "completed", count: 3 },
    resultSummary: { status: "completed", lines: ["Found three comments."] },
  };
  await page.route("**/api/pipeline-runs", (route) =>
    route.fulfill({ json: runs }),
  );
  await page.route(`**/api/pipeline-runs/${actionRun.id}`, (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route(`**/api/pipeline-runs/${actionRun.id}/logs`, (route) =>
    route.fulfill({ json: { content: "" } }),
  );
  await page.route(
    "**/api/pipelines/changing-definition/run-history?kind=action",
    async (route) => {
      expect(route.request().method()).toBe("DELETE");
      runs = runs.filter((run) => run.kind !== "action");
      await route.fulfill({ json: { deleted: 1 } });
    },
  );
  await page.goto("/");
  const recentWorkflows = page.getByRole("region", {
    name: "Recent workflow runs",
  });
  const recentActions = page.getByRole("region", {
    name: "Recent action runs",
  });
  await expect(recentWorkflows).toContainText(workflowRun.workflowName);
  await expect(recentWorkflows).not.toContainText(actionRun.workflowName);
  await expect(recentActions).toContainText(actionRun.workflowName);
  await expect(recentActions).not.toContainText(workflowRun.workflowName);
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation
    .getByRole("link", { name: "Workflow runs", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Workflow runs",
  );
  await expect(
    page.getByRole("heading", { name: workflowRun.workflowName, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: actionRun.workflowName, exact: true }),
  ).toHaveCount(0);
  await navigation
    .getByRole("link", { name: "Action runs", exact: true })
    .click();
  await expect(page).toHaveURL("/action-runs");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Action runs",
  );
  await expect(
    page.getByRole("heading", { name: actionRun.workflowName, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: workflowRun.workflowName, exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: /^Open latest run/ }).click();
  await expect(page).toHaveURL(`/runs/${actionRun.id}`);
  const back = page.getByRole("link", { name: "All action runs", exact: true });
  await expect(back).toHaveAttribute("href", "/action-runs");
  await back.click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete Focused action history" })
    .click();
  await expect(
    page.getByRole("heading", { name: "No action runs yet", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Explore actions", exact: true }),
  ).toHaveAttribute("href", "/actions");
  await navigation
    .getByRole("link", { name: "Workflow runs", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: workflowRun.workflowName, exact: true }),
  ).toBeVisible();
});

test("workflow cards link every active run and keep the latest 10 runs refreshed by polling", async ({
  page,
}, testInfo) => {
  let runs: RunSummary[] = Array.from({ length: 26 }, (_, index) => {
    const workflowId =
      index >= 24
        ? "old-workflow"
        : index % 2 === 0
          ? "feature"
          : "pr-assistant";
    return {
      id: `run-history-${index}`,
      kind: "workflow",
      workflowId,
      workflowName:
        workflowId === "feature"
          ? "Feature development"
          : workflowId === "pr-assistant"
            ? index === 19
              ? "Old PR Assistant name"
              : "PR Assistant"
            : "Old workflow",
      status: index === 0 ? "running" : index === 22 ? "queued" : "completed",
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
  await expect(
    feature.getByRole("link", { name: /^Open active run/ }),
  ).toHaveCount(2);
  await expect(feature.getByText("2 active", { exact: true })).toBeVisible();
  await expect(
    feature.getByRole("link", { name: /Open active run.*queued/ }),
  ).toHaveAttribute("href", "/runs/run-history-22");
  await expect(
    assistant.getByRole("link", { name: /^Open latest run/ }),
  ).toHaveAttribute("href", "/runs/run-history-1");
  await expect(
    feature
      .getByRole("link", { name: /Open active run.*running/ })
      .getByText("running", { exact: true }),
  ).toBeVisible();
  await expect(history.getByRole("link")).toHaveCount(4);
  await page.screenshot({
    path: testInfo.outputPath("run-cards-desktop.png"),
    fullPage: true,
  });
  const featureHistory = feature.locator("details");
  const assistantHistory = assistant.locator("details");
  const oldHistory = old.locator("details");
  for (const details of [featureHistory, assistantHistory, oldHistory])
    await details.locator("summary").click();
  await expect(history.getByRole("heading", { level: 2 })).toHaveText([
    "Feature development",
    "PR Assistant",
    "Old workflow",
  ]);
  await expect(featureHistory.getByRole("link")).toHaveCount(10);
  await expect(assistantHistory.getByRole("link")).toHaveCount(10);
  await expect(oldHistory.getByRole("link")).toHaveCount(2);
  await expect(featureHistory.getByRole("link").first()).toHaveAttribute(
    "href",
    "/runs/run-history-0",
  );
  await expect(featureHistory.getByRole("link").last()).toHaveAttribute(
    "href",
    "/runs/run-history-18",
  );
  await expect(assistantHistory.getByRole("link").last()).toHaveAttribute(
    "href",
    "/runs/run-history-19",
  );
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
  await expect(
    assistant.getByRole("link", { name: /^Open latest run/ }),
  ).toHaveAttribute("href", "/runs/run-history-new");
  await expect(history.getByRole("link")).toHaveCount(26);
  await expect(featureHistory.getByRole("link")).toHaveCount(10);
  await expect(assistantHistory.getByRole("link")).toHaveCount(10);
  await expect(oldHistory.getByRole("link")).toHaveCount(2);
  await expect(history.getByRole("heading", { level: 2 })).toHaveText([
    "PR Assistant",
    "Feature development",
    "Old workflow",
  ]);
  await expect(history.locator('a[href="/runs/run-history-19"]')).toHaveCount(
    0,
  );
  await expect(featureHistory.getByRole("link").last()).toHaveAttribute(
    "href",
    "/runs/run-history-18",
  );
  await expect(assistantHistory.getByRole("link").last()).toHaveAttribute(
    "href",
    "/runs/run-history-17",
  );
  await expect(
    assistantHistory.getByText("Scheduled run", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(feature.getByRole("heading")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("run-cards-mobile.png"),
    fullPage: true,
  });
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

test("run history confirms individual and whole-group deletion and protects active runs", async ({
  page,
}) => {
  let runs: RunSummary[] = Array.from({ length: 14 }, (_, index) => ({
    id: `run-delete-${index}`,
    kind: "workflow",
    workflowId: index < 12 ? "history" : "active",
    workflowName: index < 12 ? "History workflow" : "Active workflow",
    status: index === 12 ? "running" : index === 13 ? "queued" : "completed",
    createdAt: new Date(Date.UTC(2026, 10, 7, 12, 30 - index)).toISOString(),
    updatedAt: "2026-11-07T12:30:00Z",
    requestId: `delete-${index}`,
    units: {},
  }));
  let failed = false;
  const deleted: string[] = [];
  await page.route("**/api/pipeline-runs", (route) =>
    route.fulfill({ json: runs }),
  );
  await page.route("**/api/pipeline-runs/run-delete-*", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    if (failed) {
      await route.fulfill({
        status: 409,
        json: { error: "Run became active. Stop it before deleting." },
      });
      return;
    }
    const id = route.request().url().split("/").pop()!;
    deleted.push(id);
    runs = runs.filter((run) => run.id !== id);
    await route.fulfill({ json: { deleted: true } });
  });
  await page.route(
    "**/api/pipelines/history/run-history?kind=workflow",
    async (route) => {
      expect(route.request().method()).toBe("DELETE");
      deleted.push("group");
      const count = runs.filter((run) => run.workflowId === "history").length;
      runs = runs.filter((run) => run.workflowId !== "history");
      await route.fulfill({ json: { deleted: count } });
    },
  );
  await page.goto("/runs");
  const history = page.getByRole("region", {
    name: "History workflow",
    exact: true,
  });
  const active = page.getByRole("region", {
    name: "Active workflow",
    exact: true,
  });
  const groupDelete = history.getByRole("button", {
    name: "Delete History workflow history",
    exact: true,
  });
  await expect(groupDelete).toBeEnabled();
  await expect(
    active.getByRole("button", {
      name: "Delete Active workflow history",
      exact: true,
    }),
  ).toBeDisabled();
  await active.locator("summary").click();
  for (const id of ["run-delete-12", "run-delete-13"])
    await expect(
      active.getByRole("button", {
        name: `Delete run ${id} from history`,
        exact: true,
      }),
    ).toBeDisabled();
  await history.locator("summary").click();
  const runDelete = history.getByRole("button", {
    name: "Delete run run-delete-0 from history",
    exact: true,
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await runDelete.click();
  await expect(runDelete).toBeVisible();
  expect(deleted).toEqual([]);
  failed = true;
  page.once("dialog", (dialog) => dialog.accept());
  await runDelete.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Run became active. Stop it before deleting.",
  );
  await expect(runDelete).toBeEnabled();
  failed = false;
  page.once("dialog", (dialog) => dialog.accept());
  await runDelete.click();
  await expect(runDelete).toHaveCount(0);
  await expect(history.locator("details").getByRole("link")).toHaveCount(10);
  await expect(history.locator('a[href="/runs/run-delete-10"]')).toBeVisible();
  expect(deleted).toEqual(["run-delete-0"]);
  await page.reload();
  await expect(
    history.getByRole("link", { name: /^Open latest run/ }),
  ).toHaveAttribute("href", "/runs/run-delete-1");
  page.once("dialog", (dialog) => dialog.dismiss());
  await groupDelete.click();
  await expect(history).toBeVisible();
  expect(deleted).toEqual(["run-delete-0"]);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("including older runs");
    await dialog.accept();
  });
  await groupDelete.click();
  await expect(history).toHaveCount(0);
  await expect(active).toBeVisible();
  expect(deleted).toEqual(["run-delete-0", "group"]);
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
  expect(Object.keys(archive)).toEqual(["result.json"]);
  expect(strFromU8(archive["result.json"])).toContain(
    "Fixture output - automated testing only",
  );
  await expect(page.getByRole("alert")).not.toBeVisible();
});

test("blocked final publication still exposes the asset download without marking the run completed", async ({
  page,
}) => {
  const definition = workflow(
    `blocked-download-${crypto.randomUUID().slice(0, 8)}`,
  );
  definition.stages[1].outputSchema.properties = {
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
        input: { context: "Preserve accepted report on upload failure." },
        requestId: crypto.randomUUID(),
      },
    },
  );
  await expect(launched).toBeOK();
  const run = await launched.json();
  await page.goto(`/runs/${run.id}`);
  const button = page.getByRole("button", { name: "Download assets" });
  await expect(button).toBeVisible();
  const downloading = page.waitForEvent("download");
  await button.click();
  const download = await downloading;
  expect(await download.failure()).toBeNull();
  const file = await download.path();
  if (!file) throw new Error("Download file is missing.");
  const archive = unzipSync(fs.readFileSync(file));
  expect(JSON.parse(strFromU8(archive["run-status.json"])).status).toBe(
    "blocked",
  );
  expect(Object.hasOwn(archive, "result.json")).toBe(false);
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
    discover.getByRole("button", { name: "Re-run from Discover" }),
  ).toBeEnabled();
  await expect(
    discover.getByRole("button", { name: /^Restart from / }),
  ).toHaveCount(0);
  const report = page.getByRole("region", { name: "Report stage" });
  await expect(report).toHaveAccessibleDescription("Not executed");
  await expect(
    report.getByRole("button", { name: "View Writer input and output" }),
  ).toHaveCount(0);
  await expect(
    report.getByRole("button", { name: "Re-run from Report" }),
  ).toBeDisabled();
  await expect(
    report.getByRole("button", { name: /^Restart from / }),
  ).toHaveCount(0);
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
  await discover.getByRole("button", { name: "Re-run from Discover" }).click();
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

test("agent settings use shared configured folders instead of a per-agent folder editor", async ({
  page,
}) => {
  const root = temporaryRoot();
  const folder = path.join(root, "project with spaces");
  const otherFolder = path.join(root, "another project");
  fs.mkdirSync(folder);
  fs.mkdirSync(otherFolder);
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
    await expect(folders).toHaveCount(0);
    await expect(
      page.getByText("All agents share the folders configured", {
        exact: false,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Beta Backend default" }).click();
    await expect(folders).toHaveCount(0);
    const stored = await (
      await page.request.get(`/api/pipelines/${definition.id}`)
    ).json();
    expect(stored.value.stages[0].agents[0].allowedFolders).toBeUndefined();
    expect(stored.value.stages[0].agents[1].allowedFolders).toBeUndefined();
    expect(stored.value.stages[1].agents[0].allowedFolders).toBeUndefined();
    await page.reload();
    await page.getByRole("button", { name: "Alpha Backend default" }).click();
    await expect(folders).toHaveCount(0);
    await page.getByRole("button", { name: "Beta Backend default" }).click();
    await expect(folders).toHaveCount(0);
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
    await expect(input).toContainText("allowedFolders");
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

test("plain-language output and repeat rules save without schema or feedback binding editors", async ({
  page,
}) => {
  const definition = workflow(
    `natural-loop-${crypto.randomUUID().slice(0, 8)}`,
  );
  for (const stage of definition.stages) {
    stage.expectedOutput = `Return the complete ${stage.name} result.`;
    stage.inputs = {};
  }
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  await page.goto(`/pipelines/${definition.id}`);
  await page.getByRole("button", { name: "02 Report", exact: true }).click();
  const repeat = page.getByRole("checkbox", {
    name: "Repeat earlier stages when a condition matches",
  });
  await repeat.check();
  const rule = "The review finds defects or missing required test coverage.";
  await page
    .getByRole("textbox", { name: "Repeat when", exact: false })
    .fill(rule);
  await expect(
    page.getByRole("region", { name: "Loop preview" }),
  ).toContainText(rule);
  for (const name of [
    "Input bindings",
    "Output schema",
    "Loop feedback bindings",
    "Custom field path",
  ])
    await expect(page.getByRole("textbox", { name, exact: true })).toHaveCount(
      0,
    );
  await expect(
    page.getByRole("combobox", { name: "Output field", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "02 Report", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Repeat when", exact: false }),
  ).toHaveValue(rule);
  await expect(
    page.getByRole("textbox", { name: "Expected output", exact: false }),
  ).toHaveValue(definition.stages[1].expectedOutput!);
  const saved = await (
    await page.request.get(`/api/pipelines/${definition.id}`)
  ).json();
  expect(saved.value.stages[1].loop).toEqual({
    targetStageId: "discover",
    condition: {
      agentId: "writer",
      pointer: "/needsAnotherPass",
      operator: "equals",
      value: true,
    },
    repeatWhen: rule,
    maxIterations: 3,
    feedback: {},
  });
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
  await expect(page.getByLabel("Stage instructions")).toHaveCount(0);
  const expectedOutput = "Return the scope and a short implementation plan.";
  await page
    .getByRole("textbox", { name: "Expected output", exact: false })
    .fill(expectedOutput);
  await expect(
    page.getByRole("textbox", { name: "Input bindings", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Output schema", exact: true }),
  ).toHaveCount(0);
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
  expect(saved.value.stages[0].expectedOutput).toBe(expectedOutput);
  expect(saved.value.stages[0].inputs).toEqual({});
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
  ).not.toContainText("stageInstructions");
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
  await page.getByRole("button", { name: "Run action", exact: true }).click();
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

test("import a reusable Markdown skill and register, pause, edit and delete a watch", async ({
  page,
}) => {
  const skillName = `Evidence standards ${crypto.randomUUID().slice(0, 8)}`;
  const watchName = `Daily triage ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/skills");
  await page.getByRole("button", { name: "New skill" }).click();
  await page.getByLabel("Skill name").fill(skillName);
  await page.getByLabel("Import Markdown").setInputFiles({
    name: "evidence.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Evidence\nSeparate observations from assumptions."),
  });
  await expect(page.getByLabel("Markdown instructions")).toHaveValue(
    "# Evidence\nSeparate observations from assumptions.",
  );
  await page.getByRole("button", { name: "Save skill" }).click();
  await expect(page.getByRole("button", { name: skillName })).toBeVisible();
  await page.goto("/watches");
  await page.getByRole("button", { name: "New watch" }).click();
  await page.getByLabel("Watch name").fill(watchName);
  await expect(
    page.getByRole("checkbox", { name: "Allow all tools for scheduled runs" }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Allow all tools for scheduled runs" })
    .check();
  await page
    .getByRole("combobox", { name: "Action or workflow", exact: true })
    .selectOption({ label: "Bug triage" });
  await page
    .getByRole("textbox", { name: "Input", exact: true })
    .fill("Recurring bug context");
  await page.getByRole("button", { name: "Save watch" }).click();
  await expect(
    page.getByRole("button", { name: watchName, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: `Pause ${watchName}` }).click();
  await expect(
    page.getByRole("button", { name: `Enable ${watchName}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: watchName, exact: true }).click();
  await expect(page.getByLabel("Schedule", { exact: true })).toHaveValue(
    "every day at 7am",
  );
  await expect(
    page.getByRole("checkbox", { name: "Allow all tools for scheduled runs" }),
  ).toBeChecked();
  await page
    .getByRole("checkbox", { name: "Allow all tools for scheduled runs" })
    .uncheck();
  await page.getByRole("button", { name: "Save watch" }).click();
  await expect(
    page.getByRole("heading", { name: "Edit watch", exact: true }),
  ).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: watchName, exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Allow all tools for scheduled runs" }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Close watch editor" }).click();

  const card = page.getByRole("region", { name: watchName, exact: true });
  const remove = card.getByRole("button", {
    name: `Delete ${watchName}`,
    exact: true,
  });
  let deletions = 0;
  await page.route("**/api/pipeline-watches/*", async (route) => {
    if (route.request().method() === "DELETE" && ++deletions === 1)
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "This watch changed. Reload before deleting.",
        }),
      });
    else await route.continue();
  });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain(
      "Existing runs and results will be kept",
    );
    await dialog.dismiss();
  });
  await remove.click();
  await expect(card).toBeVisible();
  expect(deletions).toBe(0);

  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(page.getByRole("alert")).toContainText("Reload before deleting");
  await expect(card).toBeVisible();
  await expect(remove).toBeEnabled();

  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(card).toHaveCount(0);
  expect(deletions).toBe(2);
  await page.reload();
  await expect(card).toHaveCount(0);
});
