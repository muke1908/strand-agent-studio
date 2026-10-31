import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { temporaryRoot, workflow } from "../helpers.ts";

test("saving prevents inspector and canvas edits from being silently discarded", async ({
  page,
}) => {
  const definition = workflow(`saving-${crypto.randomUUID().slice(0, 8)}`);
  await expect(
    await page.request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    }),
  ).toBeOK();
  await page.goto(`/pipelines/${definition.id}`);
  await page.getByRole("button", { name: "Alpha Backend default" }).click();
  const instructions = page.getByLabel("Agent instructions");
  await instructions.fill("Keep this submitted instruction.");
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
  await expect(instructions).toHaveValue("Keep this submitted instruction.");
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
    await expect(
      page.getByText("Fixture output - automated testing only", {
        exact: false,
      }),
    ).toBeVisible();
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
  await page
    .getByLabel("Agent instructions")
    .fill("Cross-check claims against supplied evidence.");
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
  await expect(
    page.getByText("Fixture output - automated testing only", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Browser triage" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View Understand contract input and output" })
    .click();
  const contractDialog = page.getByRole("dialog", {
    name: "Understand contract",
  });
  await expect(contractDialog).toBeVisible();
  await expect(
    contractDialog.getByRole("region", { name: "Input", exact: true }),
  ).toContainText('"type": "object"');
  await expect(
    contractDialog.getByRole("region", { name: "Output", exact: true }),
  ).toContainText('"type": "object"');
  await page.keyboard.press("Escape");
  await expect(contractDialog).not.toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "View Understand contract input and output",
    }),
  ).toBeFocused();
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
  await expect(page.getByRole("alert")).toContainText("invalid JSON");
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
  await page.getByRole("button", { name: "Close watch editor" }).click();
});
