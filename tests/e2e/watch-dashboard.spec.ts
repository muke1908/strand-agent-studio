import { test, expect } from "@playwright/test";
import type { Json, WatchDashboardItem } from "../../shared/contracts.ts";

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
