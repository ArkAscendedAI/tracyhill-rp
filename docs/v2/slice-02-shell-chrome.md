# Slice 2 Parity Follow-up: Shell Chrome

## Goal
Restore the current in-repo `v1` workspace-shell organization more closely:
- footer-level `Campaigns` entry point
- collapsible `Options` submenu for account/admin surfaces
- shell-level bridge buttons outside the options submenu
- collapsible active-session stats bar

## Implemented
- `CampaignPanel` now opens from a dedicated shell `Campaigns` button instead of staying always mounted in main content
- authenticated shell actions now route through a `v1`-style footer layout:
  - `Campaigns`
  - `Options`
  - admin `Claude Code`
  - admin `Codex`
  - `Log Out`
- `Options` now owns:
  - `Provider Keys`
  - `Password`
  - `MFA`
  - admin `Users`
  - admin `Storage`
  - admin `Audit`
  - `Delete Account`
- active conversation now exposes a collapsible bottom stats bar instead of relying only on top-of-pane stat cards

## Acceptance Evidence
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npx playwright test --config apps/web/playwright.config.ts apps/web/e2e/auth.spec.ts`

## Audit Outcome
- `Gap 2.2` is closed inside the audited scope
- no additional Slice 2 shell-organization gaps were confirmed beyond the already-tracked nested-folder hierarchy gap

## Remaining Slice 2 Gap
- nested folders remain missing; current `v2` folder hierarchy is still flatter than `v1`

## 2026-04-12 Re-opened UX Audit
- live test exposed that the earlier closure was too generous
- `v2` shell chrome had drifted into a bulky card-based sidebar that no longer felt like `v1`'s literal expandable file tree
- true sidebar collapse behavior had also regressed in practice
- the current repair pass restores:
  - a collapsible shell rail
  - denser explorer-style sidebar presentation
  - inline create-session/create-folder flows instead of large static sidebar cards
- a second live-feedback follow-up tightened the shell further:
  - reduced sidebar width to a denser explorer rail
  - compacted folder/session row actions into hover affordances instead of always-visible buttons
  - reduced footer and explorer spacing so long names and deeper trees fit more naturally
- do not treat this slice as closed again until the repaired explorer shell is validated on live test
