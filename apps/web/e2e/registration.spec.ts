import { expect, test } from "@playwright/test";

test("registers a new account", async ({ page }) => {
  const suffix = Date.now();
  const username = `registered_${suffix}`;
  const email = `registered_${suffix}@example.com`;
  const password = "DemoPass9A";

  await page.goto("/register");
  await page.getByLabel("Register username").fill(username);
  await page.getByLabel("Register email").fill(email);
  await page.getByLabel("Register password").fill(password);
  await page.getByLabel("Register confirm password").fill(password);
  await page.getByLabel("Agree to terms").check();
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "Verify Email" })).toBeVisible();
  const codeText = await page.getByLabel("Development verification code").textContent();
  const code = codeText?.match(/\d{6}/)?.[0];
  if (!code) throw new Error("verification code not found");
  await page.getByLabel("Registration verification code").fill(code);
  await page.getByRole("button", { name: "Verify And Sign In" }).click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Log Out" }).click();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Login" })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log In" }).click();
  await expect(page.getByRole("heading", { name: "Two-Step Verification" })).toBeVisible();
  const mfaCodeText = await page.getByLabel("Development MFA code").textContent();
  const mfaCode = mfaCodeText?.match(/\d{6}/)?.[0];
  if (!mfaCode) throw new Error("mfa verification code not found");
  await page.getByLabel("MFA verification code").fill(mfaCode);
  await page.getByRole("button", { name: "Verify And Sign In" }).click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
});
