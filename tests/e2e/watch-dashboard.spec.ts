import { test, expect } from "@playwright/test";
import type {
  Decision,
  Json,
  Saved,
  WatchDashboardItem,
  Workflow,
} from "../../shared/contracts.ts";

function watchResult(
  id: string,
  name: string,
  result: Json,
): WatchDashboardItem {
  return {
    value: {
      id,
      name,
      workflowId: id,
      enabled: true,
      policyId: "schedule-cron",
      settings: { expression: "*/5 * * * *", timeZone: "UTC" },
      inputBindings: {},
      cooldownSeconds: 60,
      maxRunsPerHour: 12,
    },
    revision: id,
    state: {
      id,
      nextCheck: "2026-11-03T17:35:00Z",
      decisions: [],
    },
    latestRun: {
      id: `run-${id}`,
      status: "completed",
      createdAt: "2026-11-03T17:30:00Z",
      updatedAt: "2026-11-03T17:31:00Z",
      result,
    },
  };
}

test("dashboard retains previous output while polling running, failed and recovered results", async ({
  page,
}) => {
  const rows = [
    watchResult("assigned", "Assigned PRs", {
      summary: "17 active reviewer assignments.",
      assignedPrCount: 17,
    }),
    watchResult("comments", "Open comments", {
      summary: "No open threads.",
      openCommentCount: 0,
    }),
  ];
  await page.route("**/api/watch-dashboard", (route) =>
    route.fulfill({ json: rows }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Dashboard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("article")).toHaveCount(2);
  const assigned = page.getByRole("article", { name: "Assigned PRs" });
  const comments = page.getByRole("article", { name: "Open comments" });
  await expect(assigned.getByText("17", { exact: true })).toBeVisible();
  await expect(comments.getByText("0", { exact: true })).toBeVisible();
  await expect(
    assigned.getByRole("link", { name: "Open latest run" }),
  ).toHaveAttribute("href", "/runs/run-assigned");
  await assigned.getByText("View full output", { exact: true }).click();
  await expect(
    assigned.getByText('"assignedPrCount": 17', { exact: false }),
  ).toBeVisible();
  const prior = rows[0].latestRun!;
  rows[0].previousResultRun = {
    id: prior.id,
    updatedAt: prior.updatedAt,
    result: prior.result!,
  };
  rows[0].latestRun = {
    id: "run-new",
    status: "queued",
    createdAt: "2026-11-03T17:35:00Z",
    updatedAt: "2026-11-03T17:35:01Z",
  };
  await expect(assigned.getByText("queued", { exact: true })).toBeVisible();
  await expect(assigned.getByText("17", { exact: true })).toBeVisible();
  await expect(
    assigned.getByText("Showing previous result from"),
  ).toBeVisible();
  await expect(
    assigned.getByRole("link", { name: "Open latest run" }),
  ).toHaveAttribute("href", "/runs/run-new");
  await expect(
    assigned.getByRole("link", { name: "Open previous result run" }),
  ).toHaveAttribute("href", "/runs/run-assigned");
  rows[0].latestRun.status = "running";
  await expect(assigned.getByText("running", { exact: true })).toBeVisible();
  await expect(assigned.getByText("17", { exact: true })).toBeVisible();
  await expect(
    assigned.getByText('"assignedPrCount": 17', { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(assigned.getByText("running", { exact: true })).toBeVisible();
  await expect(assigned.getByText("17", { exact: true })).toBeVisible();
  await expect(comments.getByText("0", { exact: true })).toBeVisible();
  rows[0].latestRun.status = "blocked";
  rows[0].latestRun.error = "Azure authentication expired";
  await expect(assigned.getByRole("alert")).toHaveText(
    "Azure authentication expired",
  );
  await expect(assigned.getByText("17", { exact: true })).toBeVisible();
  rows[0].latestRun.status = "completed";
  delete rows[0].latestRun.error;
  rows[0].latestRun.result = {
    summary: "No assigned PRs.",
    assignedPrCount: 0,
  };
  delete rows[0].previousResultRun;
  await expect(assigned.getByText("0", { exact: true })).toBeVisible();
  await expect(assigned.getByText("17", { exact: true })).toHaveCount(0);
  await expect(assigned.getByText("Showing previous result from")).toHaveCount(
    0,
  );
  await expect(assigned.getByRole("alert")).toHaveCount(0);
  rows[0].value.enabled = false;
  await expect(assigned.getByText("paused", { exact: true })).toBeVisible();
  await expect(assigned.getByText("0", { exact: true })).toBeVisible();
});

test("dashboard distinguishes no watches, waiting results and API failures", async ({
  page,
}) => {
  let rows: WatchDashboardItem[] = [];
  let failed = false;
  await page.route("**/api/watch-dashboard", (route) =>
    failed
      ? route.fulfill({
          status: 503,
          json: { error: "Watcher results unavailable" },
        })
      : route.fulfill({ json: rows }),
  );
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "No watches yet" }),
  ).toBeVisible();
  const waiting = watchResult("waiting", "New watch", null);
  delete waiting.latestRun;
  rows = [waiting];
  await expect(
    page.getByText("Waiting for the first scheduled run."),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
  waiting.latestRun = {
    id: "run-first",
    status: "running",
    createdAt: "2026-11-03T17:35:00Z",
    updatedAt: "2026-11-03T17:35:01Z",
  };
  await expect(
    page.getByText("Check in progress. No result yet."),
  ).toBeVisible();
  failed = true;
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText(
    "Watcher results unavailable",
  );
  await expect(
    page.getByRole("heading", { name: "No watches yet" }),
  ).toHaveCount(0);
});

test("watcher output cards fit a narrow viewport and preserve full long output", async ({
  page,
}) => {
  const rows = [
    watchResult("assigned", "Assigned PRs", {
      summary: "Assigned PRs to review.",
      assignedPrCount: 17,
      evidence: "a".repeat(300),
    }),
    watchResult("waiting", "Another watch", null),
  ];
  await page.route("**/api/watch-dashboard", (route) =>
    route.fulfill({ json: rows }),
  );
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/dashboard");
  await expect(page.getByRole("article")).toHaveCount(2);
  await page.getByText("View full output").click();
  await expect(page.getByText('"evidence":', { exact: false })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("configure an action using a workflow dropdown and a plain-language condition", async ({
  page,
  request,
}) => {
  const definitions = (await (
    await request.get("/api/pipelines")
  ).json()) as Saved<Workflow>[];
  const suffix = Date.now().toString(36);
  for (const role of ["check", "action"]) {
    const definition = {
      ...definitions[0].value,
      id: `cycle-ui-${role}-${suffix}`,
      name: `Cycle UI ${role} ${suffix}`,
      result: {
        source: "stage",
        stageId: definitions[0].value.stages.at(-1)!.id,
        agentId: definitions[0].value.stages.at(-1)!.agents[0].id,
        pointer: "",
      },
    };
    const response = await request.put(`/api/pipelines/${definition.id}`, {
      data: { value: definition },
    });
    expect(response.ok()).toBe(true);
  }
  await page.goto("/watches");
  await page.getByRole("button", { name: "New watch", exact: true }).click();
  await page.getByLabel("Watch name").fill(`Conditional work ${suffix}`);
  await page
    .getByRole("combobox", { name: "Workflow", exact: true })
    .selectOption(`cycle-ui-check-${suffix}`);
  await page
    .getByLabel("Workflow input bindings")
    .fill('{"context":{"source":"literal","value":"Check work"}}');
  await page
    .getByRole("checkbox", {
      name: "Run an action workflow when the check qualifies",
    })
    .check();
  await expect(page.getByLabel("Action configuration")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Action workflow", exact: true })
    .selectOption(`cycle-ui-action-${suffix}`);
  const condition = "Run when the check produces a nonempty summary.";
  await page.getByLabel("When to run", { exact: true }).fill(condition);
  await page.getByLabel("Workflow input bindings").fill("{");
  await expect(page.getByRole("button", { name: "Save watch" })).toBeDisabled();
  await page.getByLabel("When to run", { exact: true }).fill(`${condition} `);
  await expect(page.getByRole("button", { name: "Save watch" })).toBeDisabled();
  await page
    .getByLabel("Workflow input bindings")
    .fill('{"context":{"source":"literal","value":"Check updated work"}}');
  await expect(page.getByRole("button", { name: "Save watch" })).toBeEnabled();
  await page.getByRole("button", { name: "Save watch" }).click();
  await expect(
    page.getByRole("button", {
      name: `Conditional work ${suffix}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Pause Conditional work ${suffix}` })
    .click();
  await expect(
    page.getByRole("button", { name: `Enable Conditional work ${suffix}` }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Conditional work ${suffix}`, exact: true })
    .click();
  await expect(page.getByLabel("When to run", { exact: true })).toHaveValue(
    condition,
  );
  await expect(page.getByLabel("When to run", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(
    page.getByRole("combobox", { name: "Action workflow", exact: true }),
  ).toHaveValue(`cycle-ui-action-${suffix}`);
  await expect(
    page.getByRole("combobox", { name: "Action workflow", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("checkbox", {
      name: "Run an action workflow when the check qualifies",
    }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Close watch editor" }).click();
});

test("a condition compilation error preserves the selected action and sentence", async ({
  page,
}) => {
  await page.route("**/api/pipeline-watches/*", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const body = route.request().postDataJSON();
    expect(body.value.action.whenToRun).toBe(
      "Run when the latest comment is older than 30 minutes.",
    );
    expect(body.value.action.conditions).toBeUndefined();
    await route.fulfill({
      status: 400,
      json: { error: "The check does not provide a comment timestamp." },
    });
  });
  await page.goto("/watches");
  await page.getByRole("button", { name: "New watch", exact: true }).click();
  await page
    .getByRole("checkbox", {
      name: "Run an action workflow when the check qualifies",
    })
    .check();
  const action = page.getByRole("combobox", {
    name: "Action workflow",
    exact: true,
  });
  const selected = await action.inputValue();
  const sentence = "Run when the latest comment is older than 30 minutes.";
  await page.getByLabel("When to run", { exact: true }).fill(sentence);
  await page.getByRole("button", { name: "Save watch" }).click();
  await expect(
    page.getByText("The check does not provide a comment timestamp.").last(),
  ).toBeVisible();
  await expect(action).toHaveValue(selected);
  await expect(page.getByLabel("When to run", { exact: true })).toHaveValue(
    sentence,
  );
  await expect(page.getByRole("button", { name: "Save watch" })).toBeEnabled();
});

test("watch cards and dashboard distinguish automatic suspension from manual Pause", async ({
  page,
}) => {
  const item = watchResult("cycle-visible", "Conditional processing", {
    count: 2,
  });
  item.value.action = {
    workflowId: "action",
    conditions: [{ pointer: "/count", operator: "greaterThan", value: 0 }],
    inputBindings: {},
    recheckSeconds: 600,
  };
  item.state.phase = "checking";
  item.state.activeRunId = "run-check";
  await page.route("**/api/pipeline-watches", (route) =>
    route.fulfill({ json: [item] }),
  );
  await page.route("**/api/watch-dashboard", (route) =>
    route.fulfill({ json: [item] }),
  );
  await page.goto("/watches");
  await expect(page.getByText("checking", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open active run" }),
  ).toHaveAttribute("href", "/runs/run-check");
  item.state.phase = "acting";
  item.state.activeRunId = "run-action";
  await expect(page.getByText("acting", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open active run" }),
  ).toHaveAttribute("href", "/runs/run-action");
  item.state.phase = "waiting";
  item.state.activeRunId = "run-manual";
  await expect(page.getByText("waiting", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open active run" }),
  ).toHaveAttribute("href", "/runs/run-manual");
  item.value.enabled = false;
  await expect(page.getByText("paused", { exact: true })).toBeVisible();
  await page.goto("/dashboard");
  await expect(page.getByText("paused", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open active run" }),
  ).toHaveAttribute("href", "/runs/run-manual");
  item.value.enabled = true;
  item.state.phase = "watching";
  delete item.state.activeRunId;
  await expect(page.getByText("watching", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open active run" })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Next scheduled check:", { exact: false }),
  ).toBeVisible();
});

test.describe("readable watch schedules", () => {
  test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

  test("separates hourly runs from scheduler polling on both watch pages", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-11-05T16:59:13Z"));
    const hourly = watchResult("hourly", "Hourly Teams digest", {});
    hourly.value.settings = {
      expression: "0 * * * *",
      timeZone: "Europe/Berlin",
    };
    hourly.state.nextCheck = "2026-11-05T16:59:48Z";
    await page.route(/\/api\/(watch-dashboard|pipeline-watches)$/, (route) =>
      route.fulfill({ json: [hourly] }),
    );
    for (const path of ["/dashboard", "/watches"]) {
      await page.goto(path);
      const card = page.getByRole(
        path === "/dashboard" ? "article" : "region",
        {
          name: "Hourly Teams digest",
        },
      );
      await expect(
        card.getByText("Schedule: Every hour, on the hour (Europe/Berlin)"),
      ).toBeVisible();
      await expect(card.getByText("Next scheduled run:")).toHaveText(
        /Next scheduled run: Nov 5, 2026, 6:00 PM GMT\+1/,
      );
      await expect(card.getByText("Next scheduler check:")).toBeHidden();
      await card.getByText("Scheduler details", { exact: true }).click();
      await expect(card.getByText("Next scheduler check:")).toHaveText(
        /Next scheduler check: Nov 5, 2026, 5:59 PM GMT\+1/,
      );
      await expect(
        card.getByText("The scheduler checks about once a minute", {
          exact: false,
        }),
      ).toBeVisible();
    }
    hourly.value.enabled = false;
    await expect(page.getByText("paused", { exact: true })).toBeVisible();
    await expect(page.getByText("Next scheduled run:")).toHaveCount(0);
    await expect(page.getByText("Paused. No automatic runs.")).toBeVisible();
  });

  test("shows only the latest two localized scheduled events and invalid schedule errors", async ({
    page,
  }) => {
    const assigned = watchResult("assigned", "PRs assigned to me", {});
    assigned.state.decisions = [
      "2026-11-05T16:45:00.000Z",
      "2026-11-05T16:50:00.000Z",
      "2026-11-05T16:55:00.000Z",
      "2026-11-05T17:00:00.000Z",
    ].map<Decision>((eventId, index) => ({
      resourceId: "schedule",
      eventId,
      reason: `Scheduled for ${eventId}`,
      input: {},
      status: "launched",
      runId: `run-assigned-${index}`,
      observedAt: eventId,
    }));
    const invalid = watchResult("invalid", "Invalid schedule", {});
    invalid.value.settings.expression = "not a cron";
    await page.route("**/api/pipeline-watches", (route) =>
      route.fulfill({ json: [assigned, invalid] }),
    );
    await page.goto("/watches");
    const card = page.getByRole("region", { name: "PRs assigned to me" });
    await expect(
      card.getByText("Schedule: Every 5 minutes (UTC)"),
    ).toBeVisible();
    await expect(card.getByText("Scheduled time:")).toHaveText([
      /Scheduled time: Nov 5, 2026, 6:00 PM GMT\+1/,
      /Scheduled time: Nov 5, 2026, 5:55 PM GMT\+1/,
    ]);
    await expect(
      card.getByText("Scheduled for 2026-11-05T16:55:00.000Z"),
    ).toHaveCount(0);
    await expect(
      card.getByRole("link", { name: "Open run", exact: false }).first(),
    ).toHaveAttribute("href", "/runs/run-assigned-3");
    await expect(
      page.getByRole("region", { name: "Invalid schedule" }).getByRole("alert"),
    ).toContainText("Invalid schedule:");
  });
});
