import { Router } from "express";

import type { AuthOptionsResponse, LegalTextResponse } from "@tracyhill-rp/contracts";

import type { SettingsService } from "../../domain/settings/settingsService";
import type { SetupService } from "../../domain/setup/setupService";
import type { AuthEmailService } from "../../services/authEmail";

// Public, before sign-in: what the sign-in pages offer on this server, and the server's terms and privacy
// text. The web app and the Android app read the same answers.
export function createAuthOptionsRoutes(settings: SettingsService, setup: SetupService, authEmail: AuthEmailService) {
  const router = Router();

  router.get("/options", (_req, res) => {
    const emailWorks = authEmail.isAvailable();
    const accounts = settings.accounts();
    const body: AuthOptionsResponse = {
      setupRequired: setup.isSetupRequired(),
      registrationOpen: accounts.registration === "open" && emailWorks,
      passwordResetAvailable: emailWorks,
      termsRequired: accounts.termsRequired,
    };
    res.json(body);
  });

  router.get("/legal", (_req, res) => {
    const accounts = settings.accounts();
    const body: LegalTextResponse = { termsText: accounts.termsText, privacyText: accounts.privacyText };
    res.json(body);
  });

  return router;
}
