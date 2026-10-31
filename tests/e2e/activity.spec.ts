import { test, expect } from "@playwright/test";

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
  const contractCard = page.getByRole("button", {
    name: "View Collect contract input and output",
  });
  await contractCard.click();
  const contract = page.getByRole("dialog", { name: "Collect contract" });
  await expect(
    contract.getByRole("region", { name: "Output", exact: true }),
  ).toContainText('"type": "object"');
  await page.keyboard.press("Escape");
  await expect(contract).not.toBeVisible();
  await expect(contractCard).toBeFocused();
  await contractCard.click();
  await expect(
    contract.getByRole("region", { name: "Input", exact: true }),
  ).toContainText('"type": "object"');
  await contract
    .getByRole("button", { name: "Close activity details" })
    .click();
  await expect(contract).not.toBeVisible();
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
  await agent.getByRole("button", { name: "Close activity details" }).click();
  await expect(agent).not.toBeVisible();
  await expect(agentCard).toBeFocused();
});
