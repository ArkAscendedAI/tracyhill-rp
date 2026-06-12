import { expect, test } from "@playwright/test";

test("browser smoke on imported v1 data", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByLabel("Username").fill("legacy-admin");
  await page.getByLabel("Password").fill("import-pass");
  await page.getByRole("button", { name: "Log In" }).click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();

  const optionsButton = page.getByRole("button", { name: "Options" });
  const openOptions = async () => {
    if ((await optionsButton.getAttribute("aria-expanded")) !== "true") await optionsButton.click();
  };

  await expect(page.getByRole("heading", { name: "Standalone Legacy" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Campaign Legacy/ })).toBeVisible();
  await expect(page.getByText("notes.md", { exact: true })).toBeVisible();
  await expect(page.getByText("scene.pdf", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Campaigns" }).click();
  const campaignsDialog = page.getByRole("dialog", { name: "Campaigns" });
  await expect(campaignsDialog).toBeVisible();
  const campaignCard = campaignsDialog.locator('article.placeholder-card').filter({ hasText: "Imported Campaign" }).first();
  await expect(campaignCard).toContainText("Version 4");
  await campaignCard.getByRole("button", { name: "Show History" }).click();
  await expect(campaignCard.getByText("Version 3", { exact: true })).toBeVisible();
  await campaignsDialog.getByRole("button", { name: "Close" }).click();

  await openOptions();
  await page.getByRole("button", { name: "Provider Keys" }).click();
  const providerKeysDialog = page.getByRole("dialog", { name: "Provider Keys" });
  await expect(providerKeysDialog).toBeVisible();
  await expect(providerKeysDialog.getByText("Legacy Endpoint", { exact: true })).toBeVisible();
  await providerKeysDialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: /Campaign Legacy/ }).click();
  await expect(page.getByRole("heading", { name: "Campaign Legacy" })).toBeVisible();
  await expect(page.getByText("Campaign Context")).toBeVisible();
  await page.getByLabel("Message prompt").fill("Continue imported browser parity.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Continue imported browser parity\./)).toBeVisible();
});
