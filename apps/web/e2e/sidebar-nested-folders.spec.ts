import { expect, test } from "@playwright/test";

test("creates nested folders and places sessions inside child folders", async ({ page }) => {
  const rootName = `Root ${Date.now()}`;
  const childName = `Child ${Date.now()}`;
  const grandchildName = `Grandchild ${Date.now()}`;
  const sessionName = `Nested Session ${Date.now()}`;

  await page.goto("/");
  await page.getByLabel("Username").fill("demo");
  await page.getByLabel("Password").fill("demo-pass");
  await page.getByRole("button", { name: "Log In" }).click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();

  await page.getByLabel("New folder name").fill(rootName);
  await page.getByRole("button", { name: "Create" }).first().click();
  await expect(page.locator(".folder-card").filter({ has: page.getByRole("button", { name: new RegExp(rootName) }) }).first()).toBeVisible();

  await page.getByLabel("New folder name").fill(childName);
  await page.getByLabel("New folder parent").selectOption({ label: rootName });
  await page.getByRole("button", { name: "Create" }).first().click();
  await expect(page.locator(".folder-card").filter({ has: page.getByRole("button", { name: new RegExp(childName) }) }).first()).toBeVisible();

  await page.getByLabel("New folder name").fill(grandchildName);
  await page.getByLabel("New folder parent").selectOption({ label: `.. ${childName}` });
  await page.getByRole("button", { name: "Create" }).first().click();

  const rootCard = page.locator(".folder-card").filter({ has: page.getByRole("button", { name: new RegExp(rootName) }) }).first();
  const childCard = rootCard.locator(".folder-card").filter({ has: page.getByRole("button", { name: new RegExp(childName) }) }).first();
  const grandchildCard = childCard.locator(".folder-card").filter({ has: page.getByRole("button", { name: new RegExp(grandchildName) }) }).first();

  await expect(childCard).toBeVisible();
  await expect(grandchildCard).toBeVisible();

  await page.getByLabel("New session name").fill(sessionName);
  await page.getByLabel("New session folder").selectOption({ label: `.. ${childName}` });
  await page.getByRole("button", { name: "Create" }).nth(1).click();

  await expect(childCard.getByRole("button", { name: new RegExp(sessionName) })).toBeVisible();
  await expect(grandchildCard).toContainText(`Path: ${rootName} / ${childName} / ${grandchildName}`);
});
