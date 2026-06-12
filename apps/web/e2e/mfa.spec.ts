import { expect, test } from "@playwright/test";

test("requires email-verified users to complete MFA during login", async ({ page }) => {
  const suffix = Date.now();
  const username = `mfa_${suffix}`;
  const email = `mfa_${suffix}@example.com`;
  const password = "DemoPass9A";

  await page.goto("/register");
  await page.getByLabel("Register username").fill(username);
  await page.getByLabel("Register email").fill(email);
  await page.getByLabel("Register password").fill(password);
  await page.getByLabel("Register confirm password").fill(password);
  await page.getByLabel("Agree to terms").check();
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "Verify Email" })).toBeVisible();
  const registrationCodeText = await page.getByLabel("Development verification code").textContent();
  const registrationCode = registrationCodeText?.match(/\d{6}/)?.[0];
  if (!registrationCode) throw new Error("registration verification code not found");
  await page.getByLabel("Registration verification code").fill(registrationCode);
  await page.getByRole("button", { name: "Verify And Sign In" }).click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Log Out" }).click();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Login" })).toBeVisible();

  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log In" }).click();
  await expect(page.getByRole("heading", { name: "Two-Step Verification" })).toBeVisible();
  await page.getByLabel("Trust this device").check();
  const mfaCodeText = await page.getByLabel("Development MFA code").textContent();
  const mfaCode = mfaCodeText?.match(/\d{6}/)?.[0];
  if (!mfaCode) throw new Error("mfa verification code not found");
  await page.getByLabel("MFA verification code").fill(mfaCode);
  await page.getByRole("button", { name: "Verify And Sign In" }).click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
  const optionsButton = page.getByRole("button", { name: "Options" });
  if ((await optionsButton.getAttribute("aria-expanded")) !== "true") await optionsButton.click();
  await page.getByRole("button", { name: "MFA" }).click();
  const accountDialog = page.getByRole("dialog", { name: "MFA" });
  const maskedEmail = `${email.slice(0, 2)}******${email.slice(email.indexOf("@"))}`;
  await expect(accountDialog.getByRole("heading", { name: "MFA Status" })).toBeVisible();
  await expect(accountDialog.getByText(`Email MFA is active for ${maskedEmail}.`)).toBeVisible();
  await expect(accountDialog.getByRole("heading", { name: "Trusted Devices" })).toBeVisible();
  await expect(accountDialog.getByText("Chrome")).toBeVisible();
  await accountDialog.getByRole("button", { name: "Close" }).click();

  const trustCookie = (await page.context().cookies()).find((cookie) => cookie.name === "trp.trust");
  if (!trustCookie) throw new Error("trusted device cookie not found");
  await page.context().clearCookies();
  await page.context().addCookies([trustCookie]);
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log In" }).click();
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Two-Step Verification" })).toHaveCount(0);

  if ((await optionsButton.getAttribute("aria-expanded")) !== "true") await optionsButton.click();
  await page.getByRole("button", { name: "MFA" }).click();
  const trustedAccountDialog = page.getByRole("dialog", { name: "MFA" });
  await trustedAccountDialog.getByRole("button", { name: "Revoke All Devices" }).click();
  await expect(trustedAccountDialog.getByText("No trusted devices are saved for this account.")).toBeVisible();
  await trustedAccountDialog.getByRole("button", { name: "Close" }).click();

  const staleTrustCookie = (await page.context().cookies()).find((cookie) => cookie.name === "trp.trust");
  if (!staleTrustCookie) throw new Error("stale trusted device cookie not found");
  await page.context().clearCookies();
  await page.context().addCookies([staleTrustCookie]);
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log In" }).click();
  await expect(page.getByRole("heading", { name: "Two-Step Verification" })).toBeVisible();
});
