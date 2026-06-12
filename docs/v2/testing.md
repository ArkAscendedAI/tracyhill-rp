# v2 Testing Strategy

## Required Layers
- unit tests for shared packages and domain services
- route/integration tests for API contracts
- browser tests for critical flows
- importer verification in later slices

## Slice 1 Minimum
- SQLite migration tests
- auth service tests
- auth route tests
- browser login/logout smoke test

## Slice 1 Parity Follow-up: Password And Legal
- auth service coverage proving password changes require the current password and persist the new password hash
- auth route coverage proving `/api/account/password` works for an authenticated user and relogin succeeds with the new password
- browser smoke flow proving `/terms` and `/privacy` are public plus authenticated password change, logout, and relogin

## Slice 1 Parity Follow-up: Registration
- auth service coverage proving registration stays pending until a valid verification code is confirmed, then creates a normalized verified user and authenticates the new session
- auth route coverage proving `POST /api/auth/register` is public, `POST /api/auth/register/resend` refreshes the code, and `POST /api/auth/register/verify` yields an authenticated current-user session
- browser smoke flow proving a new account can register, verify the code, reach the workspace, log out, and log back in

## Slice 1 Parity Follow-up: Account Deletion
- auth service coverage proving delete request, confirm, and execute remove the user plus owned SQLite records and generated-image files only after verification succeeds
- auth route coverage proving the staged delete-request, resend, confirm, and execute routes destroy the session, block the deleted user from logging back in, and reject deleting the last admin account at execute time
- browser smoke flow proving the dedicated delete-account dialog requires username confirmation, reaches the staged delete flow, shows the final warning state after verification, and surfaces the last-admin error on execute

## Slice 1 Parity Follow-up: Forgot Password
- auth service coverage proving forgot-password stays pending until a valid verification code is confirmed, then allows a password reset that changes later login behavior
- auth route coverage proving the request path returns the generic non-enumerating response, resend refreshes the code, verify unlocks the reset stage, and reset stores the new password
- browser smoke flow proving a newly registered account can log out, complete forgot-password verification, reset the password, and log back in through the resulting MFA challenge

## Slice 1 Parity Follow-up: MFA Challenge
- auth service coverage proving verified-email users receive a second-step login challenge, resend can refresh the code, and verify completes the authenticated session
- auth route coverage proving `POST /api/auth/login` can return an MFA challenge payload, `POST /api/auth/mfa/resend` refreshes the challenge, `POST /api/auth/mfa/verify` completes login, and `GET /api/account/mfa` reports account-side MFA state
- browser smoke flow proving a newly verified account can log out, log back in, complete MFA verification, reach the workspace, and see the dedicated MFA dialog surface

## Slice 1 Parity Follow-up: Trusted Devices
- auth service coverage proving a remembered MFA device can bypass a later password login and that password reset invalidates saved trusted devices
- auth route coverage proving trusted-device cookies can bypass MFA on later login and that account routes list and revoke remembered devices
- browser smoke flow proving a user can trust the current browser, reuse that trusted browser after clearing the session cookie, and revoke the remembered device from the dedicated MFA dialog back to MFA-required login

## Slice 1 Parity Follow-up: Account Shell
- browser smoke flow proving the authenticated shell exposes distinct `Password`, `MFA`, and `Delete Account` entry points instead of a single combined account dialog
- browser smoke flow proving the dedicated password and delete-account dialogs still complete their existing flows successfully
- public legal-page copy check proving `/terms` no longer claims already-restored auth flows are missing

## Slice 2 Minimum
- workspace/sidebar route lifecycle test
- browser create-folder/create-session/select-session smoke flow
- build/typecheck proof against shared contracts and schema

## Slice 3 Minimum
- mocked provider route test for stream + persistence
- browser send/receive smoke flow on an active session
- build/typecheck proof for chat contracts and provider-runtime package

## Slice 3 Parity Follow-up: Concurrent Session Streaming
- browser smoke flow proving one session can keep streaming while another session becomes active and starts its own stream
- focused chat route coverage stays green with timed mock streaming
- build/typecheck proof for the shell-level per-session streaming state and conversation UI wiring

## Slice 3 Parity Follow-up: Session Temperature Control
- workspace route coverage proving session temperature defaults to `1`, persists on update, and survives model switches instead of being dropped
- chat-service coverage proving persisted session temperature reaches runtime dispatch
- provider-runtime unit coverage proving eligible Anthropic, OpenAI chat-completions, xAI-compatible, and Gemini-off-thinking paths forward explicit temperature
- build/typecheck proof for the expanded session contract/schema, runtime-control UI, and provider-runtime input shape

## Slice 3 Post-Parity Follow-up: Context-Limit Soft Warning
- build/typecheck proof for the conversation-pane context estimator and model-picker warning state
- optional later browser coverage can exercise switching a long-running session down to a smaller-context model without hard-blocking the change

## Slice 2/3 UX Re-open: Shell And Conversation Layout
- build/typecheck proof for the sidebar density/collapse repairs, compact stats presentation, and split campaign-context framing
- live test validation is required before re-closing the re-opened Slice 2/3 UX gaps

## Slice 10 Increment: Importer Foundation
- importer integration coverage proving a synthetic `v1` tree can dry-run and import into a fresh SQLite/image target
- importer idempotency coverage proving the same source can be re-imported without duplicating rows
- importer report coverage proving a clean target compares as matched and deliberate target drift is surfaced as `changed`
- importer coverage proving legacy `pending/*.json` files become `pending_assistant_messages` rows and still merge through the `v2` chat recovery path
- importer coverage proving legacy `pipelines/*.json` files become normalized `pipeline_runs` rows with preserved review-state details
- chat-service coverage proving imported standalone sessions preserve `v1` prompt/seed runtime behavior after migration
- build/typecheck proof for the importer module, CLI wiring, test-fixture support, session prompt-context schema expansion, and chat runtime fallback

## Slice 10 Increment: Importer Validation
- broader multi-user importer coverage proving a more production-shaped `v1` tree can dry-run, import, and report cleanly
- repeated validation coverage proving the same source imports cleanly into multiple fresh `v2` targets and still reports cleanly after re-import
- build/typecheck proof for the richer fixture support and repeated-validation assertions

## Slice 10 Increment: Imported-Data Parity Verification
- imported-data parity coverage proving the post-import `v2` workspace service exposes imported folders, sessions, preferences, and runtime-control state correctly
- imported-data parity coverage proving campaign list/version history plus historical pipeline review state survive through the real `v2` services
- imported-data parity coverage proving provider keys, custom endpoints, imported attachments, generated-image references, and continued chat dispatch still behave correctly after import
- build/typecheck proof for the imported-data service-layer parity suite

## Slice 10 Increment: Imported-Data Route Parity
- authenticated route coverage proving imported data survives through the real `v2` workspace, campaign, pipeline, provider-key, and chat HTTP surfaces
- imported route coverage proving campaign-backed chat sessions still dispatch imported prompt context through the normal streaming endpoint
- build/typecheck proof for the imported-data route-parity suite

## Slice 10 Increment: Imported-Data Browser Parity
- browser smoke coverage proving imported data survives through the real UI after login as an imported user
- imported browser coverage proving imported sessions, campaign/version history, provider-key visibility, and continued chat all remain usable after import
- build/typecheck plus dedicated Playwright proof for the imported-data browser-smoke suite

## Slice 10 Increment: Packaging And Ops Proof
- API route coverage proving packaged `v2` can serve the built web shell for non-`/api` routes
- worker coverage proving pipeline and wizard workers honor database-backed cancel requests when the API is no longer the process holding the in-flight runtime controller
- build/typecheck proof for the packaged runtime entrypoints, static-shell serving, and dedicated-worker-safe cancellation path
- Docker image build proof for the repo-tracked `v2` workspace image
- packaged-stack smoke proving the built API serves both `/api/system/health` and `/`
- deploy-host tooling proof that the Docker host supports the repo-tracked compose deploy path
- final browser proof that the default Playwright suite stays green on the closed Slice 10 state
- final imported-data browser proof that the dedicated imported-fixture Playwright suite stays green on the same closed state

## Slice 3 Parity Follow-up: Explicit Stop Streaming
- chat-service coverage proving explicit stop aborts the active runtime request and persists a `v1`-style stopped assistant turn
- chat-route coverage proving the authenticated stop endpoint returns the typed active/inactive stop result shape
- build/typecheck proof for the expanded chat contract, stream-stop route/controller wiring, and conversation stop-button state handling

## Slice 3 Parity Follow-up: Output Truncation Warning
- provider-runtime unit coverage proving normalized truncation state is surfaced from the current built-in provider finish conditions
- chat-service coverage proving completed assistant turns append the current `v1` visible truncation warning when runtime output is cut off
- focused chat-route coverage stays green after the shared completion-contract change
- build/typecheck proof for the provider-runtime completion result shape and chat persistence wiring

## Slice 4 Increment: Attachments
- mocked provider route test for attachment persistence
- browser smoke flow remains green after attachment UI changes
- build/typecheck proof for attachment contract and schema expansion

## Slice 4 Increment: Binary Attachments
- route coverage proving binary attachments persist with explicit content modes
- browser smoke flow for attaching and sending an image from the active session composer
- build/typecheck proof for image/PDF attachment handling across contracts, schema, and UI

## Slice 4 Parity Follow-up: Provider-Native Chat Attachments
- chat route coverage proving stored attachments remain attached to earlier user turns when later requests are sent
- provider-runtime unit coverage proving Anthropic, OpenAI Responses, Google Gemini, xAI, and zAI build the expected multimodal attachment payloads or `v1`-style unsupported-PDF warning text
- build/typecheck proof for the shared runtime attachment contract and chat-service conversation assembly

## Slice 4 Parity Follow-up: Text-Only Attachment Request Shape
- provider-runtime unit coverage proving text-only attachment turns stay on plain-text request paths across Anthropic, OpenAI Responses, OpenAI/xAI/z.ai Chat Completions, and Google Gemini
- build/typecheck proof for the shared runtime attachment-shape correction

## Slice 4 Parity Follow-up: Anthropic And Gemini Multimodal Turn Folding
- provider-runtime unit coverage proving Anthropic folds consecutive same-role multimodal turns like the current `v1` builder
- provider-runtime unit coverage proving Gemini appends later same-role multimodal parts onto the prior `contents` entry like the current `v1` builder
- build/typecheck proof for the provider-local request-shape correction

## Slice 4 Parity Follow-up: OpenAI Responses Terminal Events
- provider-runtime unit coverage proving OpenAI Responses treats both `response.completed` and `response.done` as terminal completion events
- provider-runtime unit coverage proving `response.failed` surfaces as an error instead of being ignored
- build/typecheck proof for the shared Responses parser correction

## Slice 4 Parity Follow-up: Provider Max Output Routing
- provider-runtime unit coverage proving Anthropic, OpenAI Responses, Google Gemini, xAI, and zAI emit the expected per-model max-output request fields
- provider-runtime unit coverage proving configured custom-endpoint `maxOut` values flow into downstream runtime requests
- build/typecheck proof for the shared model-catalog metadata and provider-runtime routing changes

## Slice 4 Parity Follow-up: Media Turn Boundaries
- chat-service coverage proving text-only consecutive same-role turns still coalesce before runtime dispatch
- chat-service coverage proving attachment-bearing user turns remain separate provider messages instead of collapsing into one combined multimodal turn
- build/typecheck proof for the shared chat normalization change

## Slice 4 Parity Follow-up: Google Chat Model Surface
- provider-runtime unit coverage proving Gemini 2.5 still emits `thinkingBudget`, Gemini 3.x emits `thinkingLevel`, and active Google thinking pins `temperature = 1`
- workspace route coverage proving `gemini-2.5-pro` gets its model-specific default thinking budget, Gemini 3.x sessions default to enabled thinking plus `effort = "high"`, and those strongest-supported defaults re-apply on model switch
- build/typecheck proof for the expanded model-catalog metadata, workspace default routing, and Google runtime-control UI wording

## Slice 4 Parity Follow-up: Gemini Thinking Disable Shape
- provider-runtime unit coverage proving Gemini 2.5 omits `generationConfig.thinkingConfig` entirely when thinking is off while still forwarding explicit temperature
- build/typecheck proof for the shared Google runtime request-shape correction

## Slice 4 Parity Follow-up: Anthropic Chat Model Surface
- provider-runtime unit coverage proving Opus 4.6 supports `max` effort plus large thinking budgets, and lower Anthropic models omit `output_config` when the resolved effort is `high`
- workspace route coverage proving the default session baseline, Anthropic model switching, and Anthropic default runtime controls now match the restored model-specific behavior
- worker and chat-route coverage proving the new Anthropic default/fallback model metadata does not regress downstream pipeline, wizard, or chat behavior
- build/typecheck proof for the expanded Anthropic model catalog metadata, workspace defaults, runtime request-shape corrections, and fallback model changes

## Slice 4 Parity Follow-up: Anthropic Minimal Effort Mapping
- provider-runtime unit coverage proving Anthropic preserves `output_config.effort = "minimal"` instead of remapping it to `low`
- build/typecheck proof for the Anthropic effort-mapping correction

## Slice 4 Parity Follow-up: Anthropic System Blocks
- provider-runtime unit coverage proving `v1`-style campaign `systemPrompt` plus `stateSeed` payloads are restored to separate Anthropic `system` text blocks instead of one flattened block
- build/typecheck proof for the Anthropic runtime request-shape correction

## Slice 4 Parity Follow-up: OpenAI Responses Plain-Text Shape
- provider-runtime unit coverage proving attachment-free OpenAI Responses turns stay raw strings instead of being wrapped in one-item `input_text` arrays
- build/typecheck proof for the OpenAI Responses request-shape correction

## Slice 4 Parity Follow-up: OpenAI Responses Default Reasoning
- provider-runtime unit coverage proving OpenAI Responses still emits the default `reasoning` payload when no explicit effort is supplied
- build/typecheck proof for the OpenAI Responses default-reasoning correction

## Slice 4 Parity Follow-up: OpenAI Minimal Effort Mapping
- provider-runtime unit coverage proving OpenAI Responses preserves `reasoning.effort = "minimal"` instead of remapping it to `low`
- build/typecheck proof for the OpenAI Responses effort-mapping correction

## Slice 4 Parity Follow-up: PDF Warning Copy
- provider-runtime unit coverage proving warning-based unsupported-PDF paths now match the current `v1` copy that points users to Anthropic or OpenAI
- build/typecheck proof for the shared unsupported-attachment warning correction

## Slice 4 Parity Follow-up: Provider Abort Signals
- provider-runtime unit coverage proving Google Gemini, Anthropic, and z.ai chat runtimes now receive the shared `AbortSignal`
- build/typecheck proof for the provider-runtime abort-propagation correction

## Slice 4 Parity Follow-up: DeepSeek Provider Surface
- provider-runtime unit coverage proving DeepSeek restores the current built-in request shape, including text-only message shaping, `stream_options.include_usage`, model-specific `max_tokens`, and current forced-temperature behavior
- provider-key and workspace route coverage proving DeepSeek server fallback, stored user override, and built-in model ids all survive normal `v2` provider-key/session lifecycle flows
- focused chat-route coverage stays green after restoring the built-in DeepSeek provider surface
- build/typecheck proof for the provider enum, model catalog, runtime registry, worker defaults, and provider-keys dialog updates

## Slice 4 Parity Follow-up: OpenAI Chat Model Surface
- provider-runtime unit coverage proving reasoning-capable OpenAI models use the Responses path while the `gpt-4.1*` family uses Chat Completions with native image/PDF payloads and streamed usage metadata
- chat and workspace route coverage proving the current built-in OpenAI model ids stay valid through persisted session/chat lifecycle flows after removing the stale `gpt-5.4-mini` baseline, and that model switching now snaps OpenAI reasoning sessions to the strongest supported effort from the catalog
- build/typecheck proof for the expanded OpenAI model-catalog metadata, shared runtime routing split, and session-schema/default alignment

## Slice 4 Parity Follow-up: xAI And z.ai Chat Model Surface
- provider-runtime unit coverage proving the restored xAI/z.ai model ids use the expected request shapes, including z.ai always-thinking payloads and model-specific max-output routing on the expanded catalog
- chat and workspace route coverage proving the restored built-in xAI/z.ai model ids persist through session/chat lifecycle flows and that z.ai sessions now default to enabled thinking
- build/typecheck proof for the expanded xAI/z.ai model-catalog metadata, z.ai session-default correction, and legacy Grok 4.20 id cleanup migration

## Slice 4 Parity Follow-up: Runtime Conversation Normalization
- chat-service coverage proving consecutive same-role persisted messages are coalesced before runtime dispatch and that merged user turns preserve attachment ordering
- focused chat route coverage stays green after the runtime conversation-shaping change
- build/typecheck proof for the normalized chat-service dispatch path

## Slice 4 Parity Follow-up: Replay Transcript Sanitization
- chat-service coverage proving persisted meta/error turns are excluded from provider replay and that replayed assistant turns strip stop/interruption transport suffixes before runtime dispatch
- focused chat route coverage stays green after the replay transcript sanitization change
- build/typecheck proof for the shared chat replay normalization path

## Slice 4 Increment: Image Generation
- mocked image-generation route test for persistence plus image serving
- browser smoke flow for generate-image on an active session
- build/typecheck proof for image contract, storage, and message detail expansion

## Slice 4 Increment: Providers and Session Models
- workspace route coverage for default and updated session `modelId`
- mocked chat route coverage proving non-default model IDs persist on assistant messages
- browser smoke flow for changing the active session model before sending chat

## Slice 4 Increment: Anthropic
- workspace route coverage proving the default session model tracks the Anthropic baseline
- browser smoke flow for selecting the Anthropic model in the active session UI before sending chat
- build/typecheck proof for the Anthropic runtime and bootstrap wiring

## Slice 4 Increment: zAI
- workspace route coverage proving zAI model IDs persist on sessions
- browser smoke flow for selecting GLM-5 in the active session UI before sending chat
- build/typecheck proof for the zAI runtime and bootstrap wiring

## Slice 4 Increment: Google
- workspace route coverage proving Google model IDs persist on sessions
- browser smoke flow for selecting Gemini 2.5 Flash in the active session UI before sending chat
- build/typecheck proof for the Google runtime and bootstrap wiring

## Slice 4 Increment: xAI Image Generation
- image route coverage proving non-default image model IDs persist on generated assistant messages
- browser smoke flow for selecting the xAI image model before generation
- build/typecheck proof for the image-runtime registry and xAI image runtime wiring

## Slice 4 Increment: Google Image Generation
- image route coverage proving Google image model IDs persist on generated assistant messages
- browser smoke flow for selecting the Google image model before generation
- build/typecheck proof for the image-runtime registry and Google image runtime wiring

## Slice 4 Increment: zAI Image Generation
- image route coverage proving zAI image model IDs persist on generated assistant messages
- browser smoke flow for selecting the zAI image model before generation
- build/typecheck proof for the image-runtime registry and zAI image runtime wiring

## Slice 5 Increment: Workspace Search
- workspace route coverage proving session-name and message-content matches return typed search results
- browser smoke flow for searching from the sidebar, rendering result cards in the shell, and opening local in-session find with `Ctrl+F`
- build/typecheck proof for the new workspace-search contracts and UI hook

## Slice 5 Increment: Session Export
- chat route coverage proving a session exports as markdown with persisted messages and attachment markers
- browser smoke flow for exporting the active session and receiving the markdown download
- build/typecheck proof for the export contract and conversation-pane action

## Slice 5 Increment: Recycle Bin
- workspace route coverage proving soft delete, restore, search exclusion, permanent delete, and 30-day auto-purge on load
- browser smoke flow for moving an active session into the recycle bin and restoring it
- build/typecheck proof for the soft-delete schema and sidebar recycle-bin UI

## Slice 5 Increment: Organization Polish
- workspace route coverage proving bulk recycle-bin cleanup removes all deleted sessions
- browser smoke flow for emptying the recycle bin after delete/restore interactions
- build/typecheck proof for the sidebar metadata and bulk cleanup action

## Slice 6 Increment: Campaigns
- campaign route coverage proving list/create/update/delete behavior plus manual current-version control and `v1`-style `version = 0` default on manual create
- browser smoke flow for creating a campaign from the workspace shell before continuing session work
- build/typecheck proof for the campaign contracts, schema, API wiring, and UI panel

## Slice 6 Increment: Version History
- campaign route coverage proving content edits archive prior versions, restore works, and current campaign versions advance monotonically
- browser smoke flow for editing a campaign, opening history, and restoring an archived version
- build/typecheck proof for the campaign-version schema, API wiring, and history UI panel

## Slice 6 Increment: Start Session From Campaign
- workspace route coverage proving campaign-linked sessions launch with monotonic `Part N` naming and persist `campaignId`
- chat route coverage proving launched sessions expose campaign context in session detail and export under the generated session name
- browser smoke flow for launching a session from a campaign, inspecting the campaign context panel, and continuing normal chat/search/export/recycle-bin actions
- build/typecheck proof for the session campaign linkage, runtime system-prompt wiring, and launch UI action

## Slice 6 Parity Follow-up: Pipeline Archive Side Effects
- pipeline route coverage proving first-run enqueue archives the latest campaign-linked source session with `Part {campaign.version + 1} (YYYY-MM-DD)` naming and linked-folder placement when the campaign has a folder
- browser smoke flow proving the active session heading refreshes to the archived source-session name immediately after pipeline enqueue
- build/typecheck proof for the enqueue-side campaign session side effects and campaign-panel workspace refresh wiring

## Slice 6 Parity Follow-up: Campaign Folder Linking In Campaign Manager
- campaign route coverage proving regular campaign CRUD now persists optional linked-folder assignment and clearing
- workspace route coverage proving regular campaign-created folder links flow into downstream start-session behavior
- browser smoke flow proving the campaign manager can assign a linked folder, display it on the campaign card, and preserve the linked-folder workflow through start-session and pipeline actions
- build/typecheck proof for the expanded campaign contracts, service validation, and campaign-panel folder controls

## Slice 6 Parity Follow-up: Campaign Version Control
- campaign route coverage proving manual current-version create/update works, prior versions are still archived on content edits, and restore can target archived `v0` content
- pipeline route coverage proving enqueue-side archive naming now follows the real `v1` `Part {campaign.version + 1} (YYYY-MM-DD)` behavior
- browser smoke flow proving the campaign manager exposes current-version controls and preserves the versioned history/restore path after manual version seeding
- build/typecheck proof for the expanded campaign version schema, service behavior, campaign-panel controls, and archive-name correction

## Slice 6 Parity Follow-up: Campaign Runtime Prompt Shape
- chat-service coverage proving campaign-backed sessions combine campaign `systemPrompt` and `stateSeed` with `\n\n---\n\n` before runtime dispatch instead of inventing extra section labels
- focused chat route coverage stays green after the campaign runtime prompt-shape correction
- build/typecheck proof for the shared chat-service campaign-context wiring

## Slice 2 Parity Follow-up: Sidebar Drag And Drop
- browser smoke flow proving an unfiled session can be dragged into a folder through the sidebar UI
- build/typecheck proof for draggable session cards plus folder/root drop targets in the shell sidebar

## Slice 2 Parity Follow-up: Shell Chrome
- browser smoke flow proving the workspace shell routes campaign management through the footer `Campaigns` entry point and account/admin actions through the `Options` submenu
- browser smoke flow proving the active session still completes campaign, admin, provider-key, password, and delete-account workflows after the shell reorganization
- build/typecheck proof for the footer/options shell layout, campaign dialog entry point, and collapsible active-session stats bar

## Slice 2 Parity Follow-up: Nested Folders
- workspace route coverage proving folders can be created with `parentId`, invalid subtree cycles are rejected, and deleting a folder re-homes direct sessions, child folders, and linked campaign-folder references to the deleted folder's parent
- browser smoke flow proving nested folders render recursively, nested selectors can target child folders, and sessions can be created directly into a child folder
- build/typecheck proof for the expanded folder contract/schema, recursive sidebar shell, and nested folder selectors across touched campaign/session surfaces

## Slice 7 Increment: Pipeline Queue Foundation
- pipeline route coverage proving campaign runs can be enqueued, discovered from the user-level active-run endpoint, and canceled while queued or running
- worker test coverage proving queued pipeline runs are claimed, transitioned to terminal states, and marked canceled when aborted
- browser smoke flow for launching a pipeline run from the campaign panel and observing both the active-run shell banner and the latest-run status card update
- build/typecheck proof for the new `pipeline_runs` schema, worker app, API routes, and campaign-panel polling UI

## Slice 7 Increment: Pipeline Review and Approval
- pipeline route coverage proving completed runs expose durable step-level review data and can be approved into the campaign record with optional session launch
- worker test coverage proving queued runs produce seed/validation/system-prompt review output
- browser smoke flow for opening pipeline review, approving into the campaign, and optionally starting a fresh session directly from approval
- build/typecheck proof for the expanded `pipeline_runs` schema, approval route, worker execution flow, and campaign-panel review UI

## Slice 7 Increment: Pipeline Model Runtime
- campaign route and pipeline route coverage proving `pipelineModelId` persists on campaigns and is reflected in pipeline-run summaries
- worker test coverage proving campaign-selected pipeline models flow into run metadata while deterministic fallback remains intact
- browser smoke flow for selecting a campaign pipeline model before running and approving a pipeline
- build/typecheck proof for the campaign schema expansion, worker runtime wiring, and campaign-panel model selector

## Slice 7 Increment: Campaign Prompt Templates
- campaign route coverage proving custom update prompt templates persist on create and update
- browser smoke flow for filling campaign-specific prompt templates before running and approving a pipeline
- build/typecheck proof for the campaign schema expansion, worker prompt-template wiring, and expanded campaign-panel form

## Slice 7 Increment: Auto-Fix and Retry
- pipeline route coverage proving failed validation can capture fix output, approval prefers the fixed seed, and retry can create a new run linked back to the source run with optional stage-specific `fromStep` semantics
- worker test coverage proving runtime-backed validation failure produces fix edits plus a fixed state seed
- browser smoke flow for retrying a completed pipeline run from the campaign panel after approval, including validation-only retry
- build/typecheck proof for the richer pipeline review contract, retry route, and expanded campaign review UI

## Slice 7 Parity Follow-up: Review Depth
- pipeline route coverage proving system-prompt review output remains distinct from the applied system-prompt draft in both no-change and change-needed cases
- worker test coverage proving runtime-backed system-prompt review stores recommendation output separately from the final applied prompt
- browser smoke flow for opening pipeline review and seeing separate system-prompt review versus applied system-prompt output
- build/typecheck proof for the narrowed review-state contract and campaign review rendering

## Slice 7 Parity Follow-up: Operator Guidance
- worker coverage proving fix-generation and system-prompt-apply failures can end as completed reviewable runs with partial-failure guidance instead of broad run failure
- browser smoke flow proving pipeline review surfaces stronger validation/system-prompt guidance states in the campaign panel
- build/typecheck proof for the expanded pipeline review contract and campaign review UI wiring

## Slice 8 Increment: Wizard Foundation
- wizard route coverage proving template CRUD, run enqueue/list, approval into campaign/session creation, and retry lineage
- worker test coverage proving queued wizard runs produce the four campaign documents into durable review state
- browser smoke flow for saving wizard templates, running a wizard, reviewing output, and approving into a live `Part 1` session
- build/typecheck proof for the `wizard_templates` and `wizard_runs` schema, worker runtime, wizard API routes, and campaign-panel wizard studio

## Slice 8 Parity Follow-up: Transcript Context
- wizard route coverage proving transcript-bearing wizard runs persist `wizardTranscript` through enqueue, completion, and retry
- worker test coverage proving transcript-backed wizard runs preserve the transcript in durable review state
- browser smoke flow for pasting a wizard transcript before running and approving the wizard
- build/typecheck proof for the transcript-aware wizard contract, service, worker, and campaign-panel UI

## Slice 8 Parity Follow-up: Operator Controls
- wizard route coverage proving active-run discovery and cancel work for queued and running wizard runs
- worker test coverage proving aborted wizard runs land in durable `canceled` state
- browser smoke flow for launching a second wizard run, observing the shell wizard-activity banner, and canceling the run from the panel
- build/typecheck proof for wizard active/cancel contracts, service/routes, worker abort handling, shell banner, and cancel UI

## Slice 8 Parity Follow-up: Session Lifecycle
- workspace route coverage proving wizard sessions can be created once, stay out of normal search/session lists, and discard immediately instead of entering the recycle bin
- wizard route coverage proving wizard runs can source transcript context from a real wizard session and approval cleans that source session up
- browser smoke flow for creating a wizard session from the sidebar slot, chatting until `[WIZARD_READY]`, launching generation from the active conversation, and approving into a live `Part 1` session
- build/typecheck proof for `session_type`, wizard-session chat prompt wiring, sidebar slot UI, and approval cleanup behavior

## Slice 8 Parity Follow-up: Review Surface
- wizard route coverage proving approval can accept edited review drafts and persist those edits into the approved campaign, folder, and `Part 1` session
- browser smoke flow proving wizard review opens from a dedicated review dialog, allows seed editing, and approves through that dialog into the resulting live campaign session
- build/typecheck proof for the dedicated wizard review dialog, approval-payload contract expansion, and shell/campaign-panel review wiring

## Slice 9 Increment: Provider Keys
- provider-key route coverage proving authenticated users can list current provider-key status, save per-user overrides, and clear stored overrides back to server fallback visibility
- provider-key runtime coverage proving runtime resolution prefers the stored per-user key for a provider and falls back to server defaults only when no user override exists
- existing chat/image/worker coverage remains green after runtime selection switches from process-global keys to user-scoped key resolution
- build/typecheck proof for the new `provider_keys` schema, route/controller/service wiring, worker runtime selection, and shell dialog UI

## Slice 9 Increment: Admin Storage And Image Operations
- admin route coverage proving admin users can read storage stats, purge generated images, and observe generated-image cleanup in session detail while non-admin users remain blocked
- browser smoke flow proving an admin user can open the `Storage` dialog from the shell, see generated-image counts, and purge all generated images through the in-app confirmation flow
- build/typecheck proof for the admin contracts, service/controller/route wiring, and shell storage dialog UI

## Slice 9 Increment: Admin User Management
- admin route coverage proving admin users can list users, create a user, inspect that user's sessions, inspect a specific session transcript, toggle role, reset password, and delete the user while login behavior changes accordingly
- browser smoke flow proving an admin user can open the `Users` dialog from the shell and create a user through the dialog workflow
- build/typecheck proof for the admin-user contracts, service/controller/route wiring, and shell users dialog UI

## Slice 9 Increment: Custom Endpoints
- provider-key route coverage proving authenticated users can persist custom-endpoint config alongside provider-key overrides, including dynamic model metadata and endpoint cleanup
- workspace route coverage proving configured custom model ids are accepted for session model changes and normalize to `v1`-style off/no-cache runtime defaults
- chat route coverage proving configured custom model ids are accepted for persisted chat execution
- worker coverage proving pipeline and wizard summaries resolve configured custom-model labels without falling back to static built-in catalog assumptions
- browser smoke flow proving the shell `Provider Keys` dialog can add a custom endpoint and persist it through the dialog workflow
- build/typecheck proof for the new `custom_endpoints` schema, runtime/model-resolution wiring, worker user-scoped runtime fix, and shell/campaign/chat model-picker updates

## Slice 9 Increment: Codex Bridge
- codex route coverage proving admin-only status/list/messages/output/upload/send/interrupt/delete proxy behavior
- build/typecheck proof for the codex bridge contracts, API proxy wiring, and shell dialog UI

## Slice 9 Increment: Claude Code Bridge
- Claude Code route coverage proving admin-only sessions/messages/status/upload/send/stream/interrupt/delete proxy behavior
- browser smoke flow proving an admin user can open the `Claude Code` dialog from the shell
- build/typecheck proof for the Claude Code bridge contracts, API proxy wiring, and reconnecting shell dialog UI

## Slice 9 Increment: Audit Completion
- auth/account route coverage proving password change, trusted-device revoke, and staged delete-account flows emit durable audit events that can be inspected through the admin route
- admin/provider/bridge/pipeline/wizard route coverage proving the restored high-value operator actions all write `audit_events`
- browser smoke flow proving an admin user can open the shell `Audit` dialog and inspect recent events after earlier admin/provider actions
- build/typecheck proof for the new `audit_events` schema, audit repository/service wiring, admin audit route, and shell audit dialog UI

## Slice 3 Parity Follow-up: Message Lifecycle
- chat route coverage proving persisted messages can be edited, truncated after an arbitrary message, and deleted while session counts stay in sync
- browser smoke flow for editing a user message and re-sending it from the conversation pane
- build/typecheck proof for the new message-mutation contracts, routes, service logic, and conversation action bars

## Slice 3 Parity Follow-up: Runtime Controls And Prompt Templates
- workspace route coverage proving model-driven runtime defaults and explicit thinking/effort/auto-scroll updates persist on sessions
- chat route coverage proving assistant usage metadata persists on completed messages
- prompt-template route coverage proving per-user template CRUD works end to end
- browser smoke flow for creating a prompt template, injecting it as an attachment chip, and sending it through the conversation pane
- build/typecheck proof for the session runtime schema expansion, prompt-template domain, and conversation-pane runtime/template UI

## Slice 3 Parity Follow-up: Disconnect Recovery
- service coverage proving assistant output persists as pending recovery state when the browser disconnects mid-stream and merges exactly once on the next load
- existing chat route coverage remains green for the connected-stream completion path
- browser smoke flow remains green after the recovery-path sidebar refresh behavior
- build/typecheck proof for the pending-recovery schema expansion, API recovery merge logic, and conversation-pane workspace refresh behavior

## Slice 3 Parity Follow-up: Custom Model Picker
- browser smoke flow proves the active session can switch chat models through the provider-grouped custom picker instead of a native select
- build/typecheck proof for the conversation-header picker state and styling changes
- Playwright config now isolates the API under a fresh temp SQLite/image directory per run so browser coverage stays deterministic

## Slice 3 Parity Follow-up: Cost Visibility
- browser smoke flow remains green after adding estimated cost stats to the conversation detail and message usage surface
- build/typecheck proof for shared model pricing metadata plus the conversation-pane cost rendering

## Slice 3 Parity Follow-up: Cache TTL Control
- workspace route coverage proves Anthropic sessions default to `1h`, unsupported models reset to `off`, and explicit Anthropic `5m` updates persist
- browser smoke flow remains green after adding the Anthropic-only cache TTL control to the conversation runtime panel
- build/typecheck proof for the session cache TTL schema expansion, Anthropic runtime wiring, and conversation-pane cache control

## Slice 3 Parity Follow-up: Cache Accounting And Cache UI
- chat-service coverage proves cache read/write usage survives disconnect recovery and merges back into persisted assistant messages
- browser smoke flow remains green after adding cache read/write/hit-rate stats plus cache-aware per-message/session cost rendering
- build/typecheck proof for the normalized cache-usage contract expansion, Anthropic runtime parsing, and cache-aware conversation stats

## Slice 3 Parity Follow-up: Thinking Surface
- chat route coverage proves thought deltas stream over SSE and persisted assistant messages keep their `thinking` text
- chat-service coverage proves thinking survives disconnect recovery and merges back into the real assistant message
- build/typecheck proof for the normalized thinking-delta contract expansion, provider-runtime thought parsing, and conversation-pane thinking block

## Re-opened Slice 2/3 Shell UX Repair
- build/typecheck proof for the repaired shell rail, explorer-style sidebar presentation, collapsible sidebar state, collapsible runtime/context panels, and conversation-pane height behavior
- live browser validation on the test deployment is required before treating the re-opened Slice 2/3 UX gaps as closed again

## Readiness Rule
- no slice is complete until its service/route/browser coverage exists at the level that slice needs
- async domains must prove worker/service/route/browser behavior before being considered stable

## Later Coverage
- provider adapter fixtures
- normalized stream event tests
- campaign/pipeline/wizard tests
- final parity gate suite
