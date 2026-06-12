import { expect, test } from "@playwright/test";

test("moves an unfiled session into a folder via drag and drop", async ({ page }) => {
  const folderName = `Drag Folder ${Date.now()}`;
  const sessionName = `Drag Session ${Date.now()}`;

  await page.goto("/");
  await page.getByLabel("Username").fill("demo");
  await page.getByLabel("Password").fill("demo-pass");
  await page.getByRole("button", { name: "Log In" }).click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();

  await page.getByLabel("New folder name").fill(folderName);
  await page.getByRole("button", { name: "Create" }).first().click();
  await page.getByLabel("New session name").fill(sessionName);
  await page.getByRole("button", { name: "Create" }).nth(1).click();

  const sessionRow = page.locator(".session-card").filter({ has: page.getByRole("button", { name: new RegExp(sessionName) }) }).first();
  const folderCard = page.locator(".folder-card").filter({ hasText: folderName }).first();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());

  await sessionRow.dispatchEvent("dragstart", { dataTransfer });
  await folderCard.dispatchEvent("dragover", { dataTransfer });
  await folderCard.dispatchEvent("drop", { dataTransfer });
  await sessionRow.dispatchEvent("dragend", { dataTransfer });

  await expect(folderCard.getByRole("button", { name: new RegExp(sessionName) })).toBeVisible();
});
