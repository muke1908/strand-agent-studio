import { test, expect } from "@playwright/test";
import type { RunDetails, Unit } from "../../shared/contracts.ts";

test("existing result summaries generate on request, expose retry errors and keep raw output collapsed", async ({
  page,
}) => {
  const run: RunDetails = {
    id: "run-existing-result-summary",
    workflowId: "summary",
    workflowName: "Existing summary",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    requestId: "existing-summary",
    units: {},
    stages: [],
    result: [{ status: "blocked", summary: "Raw evidence - no publication" }],
  };
  await page.route(`**/api/pipeline-runs/${run.id}`, (route) =>
    route.fulfill({ json: run }),
  );
  await page.route(`**/api/pipeline-runs/${run.id}/logs`, (route) =>
    route.fulfill({ json: { content: "" } }),
  );
  let submissions = 0;
  await page.route(
    `**/api/pipeline-runs/${run.id}/result-summary`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({});
      submissions++;
      run.resultSummary =
        submissions === 1
          ? { status: "generating" }
          : {
              status: "completed",
              lines: [
                "Implementation was blocked by the required runtime.",
                "No commit, push or PR was produced.",
              ],
            };
      await route.fulfill({ status: 202, json: run.resultSummary });
    },
  );
  await page.goto(`/runs/${run.id}`);
  const result = page.getByRole("region", { name: "Result", exact: true });
  const raw = result.locator(".result-panel");
  await expect(
    result.getByRole("button", { name: "Generate summary" }),
  ).toBeVisible();
  await expect(raw).not.toBeVisible();
  expect(submissions).toBe(0);
  await result.getByText("Raw output", { exact: true }).click();
  await expect(raw).toBeVisible();
  await expect(raw).toContainText("Raw evidence - no publication");
  await result.getByText("Raw output", { exact: true }).click();
  await result.getByRole("button", { name: "Generate summary" }).click();
  await expect(result.getByRole("status")).toHaveText(
    "Generating result summary...",
  );
  await expect(
    result.getByRole("button", { name: "Generate summary" }),
  ).toHaveCount(0);
  run.resultSummary = {
    status: "failed",
    error: "Summary service unavailable",
  };
  await page.reload();
  await expect(result.getByRole("alert")).toHaveText(
    "Summary service unavailable",
  );
  await expect(raw).not.toBeVisible();
  await result.getByRole("button", { name: "Retry summary" }).click();
  await expect(result).toContainText(
    "Implementation was blocked by the required runtime.",
  );
  await expect(result).toContainText("No commit, push or PR was produced.");
  await expect(result.getByRole("alert")).toHaveCount(0);
  await expect(raw).not.toBeVisible();
  expect(submissions).toBe(2);
});

test("development-mode activity dialogs stay open and support reopening", async ({
  page,
}) => {
  const saved = await page.request.put("/api/pipelines/activity-dialog", {
    data: {
      value: {
        id: "activity-dialog",
        name: "Activity dialog",
        inputSchema: { type: "object" },
        stages: [
          {
            id: "collect",
            name: "Collect",
            inputs: { context: { source: "input", pointer: "/context" } },
            outputSchema: {
              type: "object",
              properties: { summary: { type: "string" } },
            },
            agents: [{ id: "evidence", name: "Evidence agent" }],
          },
        ],
      },
    },
  });
  expect(saved.ok()).toBe(true);
  const launched = await page.request.post(
    "/api/pipelines/activity-dialog/runs",
    {
      data: {
        input: { context: "Development-mode evidence" },
        requestId: crypto.randomUUID(),
      },
    },
  );
  expect(launched.ok()).toBe(true);
  const run = await launched.json();
  await page.goto(`/runs/${run.id}`);
  const contract = page.getByRole("status", { name: "Collect contract" });
  await expect(contract).toHaveText("Collect contract");
  await expect(contract.locator(".status")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "View Collect contract input and output",
    }),
  ).toHaveCount(0);
  const agentCard = page.getByRole("button", {
    name: "View Evidence agent input and output",
  });
  await agentCard.focus();
  await page.keyboard.press("Enter");
  const agent = page.getByRole("dialog", { name: "Evidence agent" });
  await expect(
    agent.getByRole("region", { name: "Input", exact: true }),
  ).toContainText("Development-mode evidence");
  await expect(
    agent.getByRole("region", { name: "Output", exact: true }),
  ).toContainText("Fixture output - automated testing only");
  await page.keyboard.press("Escape");
  await expect(agent).not.toBeVisible();
  await expect(agentCard).toBeFocused();
  await agentCard.click();
  await expect(
    agent.getByRole("region", { name: "Input", exact: true }),
  ).toContainText("Development-mode evidence");
  await agent.getByRole("button", { name: "Close activity details" }).click();
  await expect(agent).not.toBeVisible();
  await expect(agentCard).toBeFocused();
});

test("contract progress is non-interactive and failures stay visible without opening a dialog", async ({
  page,
}) => {
  const contractUnit: Unit = {
    stageId: "collect",
    agentId: "schema",
    name: "Collect contract",
    status: "running",
    attempts: [{ id: "schema-collect-fixture", status: "running" }],
  };
  const run: RunDetails = {
    id: "run-contract-progress",
    workflowId: "contract-progress",
    workflowName: "Contract progress",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    requestId: "contract-progress",
    currentStage: "collect",
    units: { "@schema/collect": contractUnit },
    stages: [
      {
        id: "collect",
        name: "Collect",
        agents: [{ id: "evidence", name: "Evidence agent" }],
      },
    ],
  };
  await page.route(`**/api/pipeline-runs/${run.id}`, (route) =>
    route.fulfill({ json: run }),
  );
  await page.route(`**/api/pipeline-runs/${run.id}/logs`, (route) =>
    route.fulfill({ json: { content: "" } }),
  );
  await page.goto(`/runs/${run.id}`);
  const contract = page.getByRole("status", { name: "Collect contract" });
  await expect(contract).toHaveText("Collect contract");
  await expect(contract.locator(".status")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /contract input and output/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const error = "Schema expansion removed authored constraints at /required";
  run.status = "blocked";
  run.error = error;
  contractUnit.status = "blocked";
  contractUnit.attempts = [
    { id: "schema-collect-fixture", status: "blocked", error },
  ];
  await page.reload();
  await expect(contract.locator(".status")).toHaveCount(0);
  await expect(contract.getByRole("alert")).toHaveText(error);
  await expect(page.getByRole("region", { name: "Collect stage" })).toHaveClass(
    /stage-blocked/,
  );
  await expect(
    page.getByRole("button", { name: /contract input and output/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("all pinned stages show execution styling separately from reported outcomes", async ({
  page,
}) => {
  const completedUnit = (
    stageId: string,
    agentId: string,
    outcome?: string,
  ): Unit => ({
    stageId,
    agentId,
    name: agentId === "schema" ? `${stageId} contract` : agentId,
    status: "completed",
    attempts: [{ id: `${stageId}-${agentId}`, status: "completed" }],
    ...(outcome ? { output: { status: outcome } } : {}),
  });
  const run: RunDetails = {
    id: "run-stage-progress",
    workflowId: "stage-progress",
    workflowName: "Stage progress",
    status: "running",
    currentStage: "inspect",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    requestId: "stage-progress",
    stages: [
      {
        id: "prepare",
        name: "Prepare",
        agents: [{ id: "preparer", name: "Preparer" }],
      },
      {
        id: "inspect",
        name: "Inspect",
        agents: [{ id: "inspector", name: "Inspector" }],
      },
      {
        id: "publish",
        name: "Publish",
        agents: [
          { id: "publisher", name: "PR publisher" },
          { id: "reporter", name: "Report publisher" },
        ],
      },
    ],
    units: {
      "@schema/prepare": completedUnit("prepare", "schema"),
      "prepare/preparer": completedUnit("prepare", "preparer", "ready"),
      "@schema/inspect": {
        stageId: "inspect",
        agentId: "schema",
        name: "inspect contract",
        status: "running",
        attempts: [{ id: "inspect-schema", status: "running" }],
      },
    },
  };
  await page.route(`**/api/pipeline-runs/${run.id}`, (route) =>
    route.fulfill({ json: run }),
  );
  await page.route(`**/api/pipeline-runs/${run.id}/logs`, (route) =>
    route.fulfill({ json: { content: "" } }),
  );
  await page.goto(`/runs/${run.id}`);
  const prepare = page.getByRole("region", { name: "Prepare stage" });
  const inspect = page.getByRole("region", { name: "Inspect stage" });
  const publish = page.getByRole("region", { name: "Publish stage" });
  await expect(prepare).toHaveClass(/stage-completed/);
  await expect(prepare.locator(".stage-content")).toHaveCSS(
    "background-color",
    "rgb(250, 250, 250)",
  );
  await expect(prepare.getByText("Executed", { exact: true })).toHaveCount(0);
  await expect(prepare).toHaveAccessibleDescription("Executed");
  await expect(
    prepare.getByRole("button", { name: "View Preparer input and output" }),
  ).toContainText("ready");
  await expect(inspect).toHaveClass(/stage-running/);
  await expect(inspect).toHaveAttribute("aria-busy", "true");
  await expect
    .poll(() =>
      inspect.evaluate(
        (element) => getComputedStyle(element, "::before").animationName,
      ),
    )
    .toBe("stage-border-orbit");
  await expect(publish).toHaveClass(/stage-queued/);
  await expect(
    publish.getByText("PR publisher", { exact: true }),
  ).toBeVisible();
  await expect(publish.getByRole("button", { name: /^View / })).toHaveCount(0);
  await expect(
    publish.getByRole("button", { name: "Rerun from Publish" }),
  ).toBeDisabled();
  await expect(page.locator(".page-header .status")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      inspect.evaluate(
        (element) => getComputedStyle(element, "::before").animationName,
      ),
    )
    .toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  run.currentStage = "publish";
  run.units["@schema/inspect"] = completedUnit("inspect", "schema");
  run.units["inspect/inspector"] = completedUnit(
    "inspect",
    "inspector",
    "blocked",
  );
  run.units["@schema/publish"] = completedUnit("publish", "schema");
  run.units["publish/publisher"] = completedUnit(
    "publish",
    "publisher",
    "blocked",
  );
  run.units["publish/reporter"] = {
    stageId: "publish",
    agentId: "reporter",
    name: "Report publisher",
    status: "running",
    attempts: [{ id: "publish-reporter", status: "running" }],
  };
  await page.reload();
  await expect(publish).toHaveClass(/stage-running/);
  await expect(publish).toHaveAttribute("aria-busy", "true");
  await expect(
    inspect.getByRole("button", { name: "View Inspector input and output" }),
  ).toContainText("blocked");

  run.status = "completed";
  run.units["publish/reporter"] = completedUnit(
    "publish",
    "reporter",
    "report-written",
  );
  await page.reload();
  await expect(inspect).toHaveClass(/stage-completed/);
  await expect(
    inspect.getByRole("button", { name: "View Inspector input and output" }),
  ).toContainText("blocked");
  await expect(page.locator(".run-stage .status")).toHaveCount(4);
  await expect(page.locator(".stage-heading .status")).toHaveCount(0);
  for (const agent of await page
    .getByRole("button", { name: /^View .* input and output$/ })
    .all()) {
    await expect(agent.locator(".status")).toHaveCount(1);
  }
  await expect(
    publish.getByRole("button", { name: "View PR publisher input and output" }),
  ).toContainText("blocked");
  await expect(
    publish.getByRole("button", {
      name: "View Report publisher input and output",
    }),
  ).toContainText("report-written");
  await expect(inspect).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() =>
      inspect.evaluate(
        (element) => getComputedStyle(element, "::before").animationName,
      ),
    )
    .toBe("none");

  delete run.units["prepare/preparer"].output;
  await page.reload();
  await expect(
    prepare.getByRole("button", { name: "View Preparer input and output" }),
  ).toContainText("Outcome not reported");
});

test("Skip confirms an explicit owner override, retries safely, and continues without passing the skipped stage", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const workflowId = `stage-skip-${crypto.randomUUID()}`;
  const saved = await page.request.put(`/api/pipelines/${workflowId}`, {
    data: {
      value: {
        id: workflowId,
        name: "Skip stage fixture",
        inputSchema: { type: "object" },
        stages: [
          {
            id: "prepare",
            name: "Prepare",
            outputSchema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                status: { enum: ["ready"] },
              },
            },
            agents: [{ id: "preparer", name: "Preparer" }],
          },
          ...["clarify", "inspect", "implement"].map((id) => ({
            id,
            name: id,
            outputSchema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                status: { enum: ["ready"] },
              },
            },
            agents: [{ id, name: id }],
          })),
          {
            id: "test",
            name: "Test",
            outputSchema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                status: { enum: ["blocked"] },
              },
            },
            agents: [{ id: "tester", name: "Tester" }],
          },
          {
            id: "review",
            name: "Review",
            inputs: {
              testing: {
                source: "stage",
                stageId: "test",
                agentId: "tester",
                pointer: "",
              },
            },
            outputSchema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                status: { enum: ["ready"] },
              },
            },
            agents: [{ id: "reviewer", name: "Reviewer" }],
          },
        ],
      },
    },
  });
  expect(saved.ok()).toBe(true);
  const launched = await page.request.post(
    `/api/pipelines/${workflowId}/runs`,
    { data: { input: {}, requestId: crypto.randomUUID() } },
  );
  expect(launched.ok()).toBe(true);
  const source = await launched.json();
  await page.goto(`/runs/${source.id}`);
  const open = page.getByRole("button", {
    name: "Skip Test stage",
    exact: true,
  });
  await expect(open).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Skip Review stage", exact: true }),
  ).toHaveCount(0);
  for (const body of [
    { reason: "", allowPublication: true },
    { reason: "   ", allowPublication: true },
    { reason: "No explicit publication choice" },
    { reason: "Wrong boolean", allowPublication: "true" },
    { reason: "Unknown field", allowPublication: false, extra: true },
  ]) {
    const invalid = await page.request.post(
      `/api/pipeline-runs/${source.id}/skip`,
      { data: { stageId: "test", requestId: crypto.randomUUID(), ...body } },
    );
    expect(invalid.status()).toBe(400);
  }
  const wrongStage = await page.request.post(
    `/api/pipeline-runs/${source.id}/skip`,
    {
      data: {
        stageId: "review",
        requestId: crypto.randomUUID(),
        reason: "Cannot jump a blocker",
        allowPublication: true,
      },
    },
  );
  expect(wrongStage.status()).toBe(409);
  const requests: {
    requestId: string;
    stageId: string;
    reason: string;
    allowPublication: boolean;
  }[] = [];
  await page.route(`**/api/pipeline-runs/${source.id}/skip`, async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1)
      await route.fulfill({
        status: 409,
        json: { error: "Workspace is temporarily busy" },
      });
    else await route.continue();
  });
  await open.click();
  const form = page.getByRole("form", { name: "Skip Test stage" });
  await expect(form).toBeInViewport();
  await expect(form.getByLabel("Reason for skipping")).toBeFocused();
  await expect(form).toContainText("will not execute or be marked passed");
  await expect(form.getByRole("checkbox")).not.toBeChecked();
  await expect(
    form.getByRole("button", { name: "Skip stage and continue" }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 700 });
  const dialog = page.getByRole("dialog", { name: "Skip Test?" });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(form.getByLabel("Reason for skipping")).toBeFocused();
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(open).toBeFocused();
  await page.setViewportSize({ width: 1366, height: 768 });
  await open.click();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(requests).toHaveLength(0);
  await open.click();
  await form
    .getByLabel("Reason for skipping")
    .fill("Owner skips Test for this case; keep static review");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Skip stage and continue" }).click();
  await expect(form.getByRole("alert")).toBeInViewport();
  await expect(form.getByRole("alert")).toHaveText(
    "Workspace is temporarily busy",
  );
  const continued = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/pipeline-runs/${source.id}/skip`) &&
      response.status() === 202,
  );
  await form.getByRole("button", { name: "Skip stage and continue" }).click();
  const child = await (await continued).json();
  await expect(page).toHaveURL(`/runs/${child.id}`);
  await expect(
    page.getByRole("region", { name: "Test stage", exact: true }),
  ).toHaveClass(/stage-skipped/);
  await expect(
    page.getByRole("region", { name: "Review stage", exact: true }),
  ).toHaveClass(/stage-completed/);
  await expect(page.getByText("Not a pass.", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View Tester input and output" }),
  ).toContainText("0 attempts");
  await expect(
    page.getByRole("button", { name: "Rerun from Review" }),
  ).toBeEnabled();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].allowPublication).toBe(true);
  const result = await (
    await page.request.get(`/api/pipeline-runs/${child.id}`)
  ).json();
  expect(result.units["test/tester"].status).toBe("skipped");
  expect(result.units["test/tester"].attempts).toEqual([]);
  expect(result.stageSkips[0].reason).toBe(requests[0].reason);
  const original = await (
    await page.request.get(`/api/pipeline-runs/${source.id}`)
  ).json();
  expect(original.status).toBe("blocked");
  expect(original.units["test/tester"].output.status).toBe("blocked");
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Test stage", exact: true }),
  ).toHaveClass(/stage-skipped/);
});

test("stage rerun icons confirm, surface errors, retry idempotently and open a continuation", async ({
  page,
}) => {
  const workflowId = `stage-rerun-icons-${crypto.randomUUID()}`;
  const saved = await page.request.put(`/api/pipelines/${workflowId}`, {
    data: {
      value: {
        id: workflowId,
        name: "Stage rerun icons",
        inputSchema: { type: "object" },
        stages: [
          {
            id: "prepare",
            name: "Prepare",
            outputSchema: { type: "object" },
            agents: [{ id: "preparer", name: "Preparer" }],
          },
          {
            id: "inspect",
            name: "Inspect",
            inputs: {
              prepared: {
                source: "stage",
                stageId: "prepare",
                agentId: "preparer",
                pointer: "",
              },
            },
            outputSchema: { type: "object" },
            agents: [{ id: "inspector", name: "Inspector" }],
          },
        ],
      },
    },
  });
  expect(saved.ok()).toBe(true);
  const launched = await page.request.post(
    `/api/pipelines/${workflowId}/runs`,
    {
      data: {
        input: { context: "Keep original task and branch" },
        requestId: crypto.randomUUID(),
      },
    },
  );
  expect(launched.ok()).toBe(true);
  const source = await launched.json();
  await page.goto(`/runs/${source.id}`);
  const icon = page.getByRole("button", { name: "Rerun from Inspect" });
  await expect(icon).toBeEnabled();
  await expect(icon).toHaveText("");
  await expect(icon).toHaveAttribute("title", "Rerun from Inspect");
  const before = await (
    await page.request.get(`/api/pipeline-runs/${source.id}`)
  ).json();
  const requests: { stageId: string; requestId: string }[] = [];
  await page.route(`**/api/pipeline-runs/${source.id}/rerun`, async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1)
      await route.fulfill({
        status: 409,
        json: { error: "Workspace is temporarily busy" },
      });
    else await route.continue();
  });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Earlier handoffs will be reused");
    await dialog.dismiss();
  });
  await icon.click();
  expect(requests).toHaveLength(0);
  await expect(page).toHaveURL(`/runs/${source.id}`);

  page.once("dialog", (dialog) => dialog.accept());
  await icon.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Workspace is temporarily busy",
  );
  await expect(icon).toBeEnabled();
  const continued = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/pipeline-runs/${source.id}/rerun`) &&
      response.status() === 202,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await icon.click();
  const child = await (await continued).json();
  await expect(page).toHaveURL(`/runs/${child.id}`);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].stageId).toBe("inspect");
  await expect(
    page.getByRole("link", { name: "an earlier run" }),
  ).toHaveAttribute("href", `/runs/${source.id}`);
  await expect(
    page.getByRole("button", { name: "View Preparer input and output" }),
  ).toContainText("Reused handoff");
  await expect(page.locator(".stage-completed")).toHaveCount(2);
  const finished = await (
    await page.request.get(`/api/pipeline-runs/${child.id}`)
  ).json();
  expect(finished.continuation).toEqual({
    sourceRunId: source.id,
    fromStageId: "inspect",
  });
  expect(finished.units["prepare/preparer"].attempts).toEqual([]);
  expect(finished.units["inspect/inspector"].attempts).toHaveLength(1);
  expect(
    await (await page.request.get(`/api/pipeline-runs/${source.id}`)).json(),
  ).toEqual(before);
});
