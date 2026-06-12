# Contributing to TracyHill RP

Thanks for your interest in contributing! TracyHill RP is a small, focused self-hosted project — contributions that fix bugs, add providers, or improve the self-hosted experience are always welcome. This guide covers local setup, the development workflow, and what's expected in a pull request.

## Ways to Contribute

- **Bug fixes** — reproducible issues from real usage
- **New provider integrations** — any OpenAI-compatible or native API
- **UI/UX improvements** — especially around chat ergonomics and long-form session workflows
- **Performance** — streaming, storage, query optimization
- **Documentation** — setup guides, deployment recipes, provider-specific tips

## A note on content scope

TracyHill RP is content-agnostic: it's a chat client for collaborative fiction, and the tone, content rating, and subject matter of any campaign are defined by the user via the wizard. The shipped default wizard template illustrates the structural format and uses a darker fantasy setting; contributors working on the wizard, pipeline, or context-engine paths will encounter that template and the prompts may include language consistent with adult literary fiction. Issues, PRs, and discussions framed as content complaints about the default template are out of scope here — replace the template for your deployment, or open a PR that adds an alternative tame template (we'd take that).

Issues that report ways a user can make the application generate something outside the system-prompt-defined scope (jailbreaks, prompt-injection paths, etc.) **are in scope** — those are bugs in the context engine or scene parser, not content complaints. Open them like any other bug.

## Reporting Bugs

Open an [issue](https://github.com/ArkAscendedAI/tracyhill-rp/issues) with:
- What you expected to happen
- What actually happened
- Reproduction steps
- Relevant env (Node version, Docker version, browser, provider)
- Log output if applicable (`docker logs tracyhill-rp`)

## Development Setup

TracyHill RP is a TypeScript monorepo using npm workspaces. You need **Node 20+** and either Docker or a local SQLite toolchain (the `better-sqlite3` dependency uses a prebuilt native binary on most platforms, no build tools required).

### One-time setup

```bash
git clone https://github.com/ArkAscendedAI/tracyhill-rp.git
cd tracyhill-rp
npm install

# Copy the env template and set a session secret
cp .env.example .env
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
```

### Running the app in dev mode

You'll need three terminals, one per service:

```bash
# Terminal 1: API (hot-reloads via tsx watch)
npm run dev:api

# Terminal 2: Worker (hot-reloads)
npm run dev:worker

# Terminal 3: Web frontend (Vite dev server with HMR)
npm run dev:web
```

- API serves on `http://localhost:3000`
- Vite dev server serves on `http://localhost:5173` and proxies `/api/*` to the API
- Open `http://localhost:5173` in your browser, log in with `demo` / `demo-pass`

### Running with mock providers

If you want to develop UI without burning provider tokens, set `MOCK_PROVIDER=1` in `.env`. Every LLM call returns deterministic canned responses — useful for tests, visual design, and screenshotting.

## Repository Layout

```
apps/
  api/        Express API server
  web/        React + Vite frontend
  worker/     Background job runner

packages/
  contracts/        Zod schemas shared between frontend and backend
  db/               SQLite schema + Drizzle ORM + migrations
  logging/          Structured pino logging
  model-catalog/    Per-provider model registry
  provider-runtime/ Provider wire formats + stream normalization
  test-fixtures/    Shared test data

docs/v2/      Per-slice engineering documentation

tools/
  codex-agent-service/  Optional Codex bridge agent
```

See [`README.md`](README.md#architecture) for the full architecture overview.

## Development Workflow

### Before submitting a PR

```bash
npm run typecheck     # must pass on every workspace
npm run build         # must pass on every workspace
npm test              # vitest across every workspace, must pass
```

End-to-end browser tests (optional locally, run in CI):

```bash
npm run test:e2e
```

### Adding a new LLM provider

The shortest path:

1. Implement the wire format and stream parser inside `packages/provider-runtime/src/index.ts`. Follow the existing per-provider `streamChat` factories (e.g. `createAnthropicMessagesRuntime`, `createOpenAIChatCompletionsRuntime`, `createGoogleGeminiRuntime`).
2. Add the provider to the registry dispatch in `createRegistryChatRuntime` (same file).
3. Add the model catalog entries in `packages/model-catalog/src/index.ts` (the `CHAT_MODELS` array) with `maxOut`, `ctx`, and capability flags (`supportsThinkingBudget`, `supportsAdaptiveThinking`, `supportsToggleThinking`, `thinkingAlwaysOn`, `supportsEffort`, `supportsCacheTtl`, long-context tier fields, etc.).
4. Add the provider ID to `providerIdSchema` in `packages/contracts/src/providerKeys.ts`.
5. Add a `<PROVIDER>_API_KEY` env var to `.env.example` and document it in `ENVIRONMENT.md` and `README.md`.
6. Write provider tests in `packages/provider-runtime/src/index.test.ts` using the shared test fixtures.

### Adding a new API route

1. Define request/response schemas in `packages/contracts/src/<domain>.ts`.
2. Add a controller in `apps/api/src/http/controllers/<domain>Controller.ts`.
3. Wire the route in `apps/api/src/http/routes/<domain>Routes.ts`.
4. Add supertest-based tests in `apps/api/src/http/routes/<domain>Routes.test.ts`.
5. If the route mutates state, emit an audit event.

### Database migrations

Schema lives in `packages/db/src/schema/`. Migrations are Drizzle-generated and auto-applied at API startup.

```bash
cd packages/db
npm run generate   # generate a new migration from schema diffs
npm run migrate    # apply pending migrations (also runs at API startup)
```

Never edit a migration after it's been committed — write a new one that fixes the prior state.

## Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes, including tests
4. Run `npm test && npm run typecheck && npm run build` and confirm all three pass
5. Commit with clear imperative-mood messages
6. Push to your fork and open a PR
7. Describe **what** changed and **why** in the PR body

### Commit messages

Use clear, imperative-mood subject lines:
- `Add Gemini 3.1 Flash-Lite model support`
- `Fix streaming disconnect recovery for xAI`
- `Tighten CSP headers on the API`

### What a good PR looks like

- **Scoped** — one feature or fix per PR, not three unrelated things
- **Tested** — new code lands with new tests unless genuinely untestable
- **Typecheck-clean** — no new `any` without a comment explaining why
- **Build-clean** — `npm run build` produces no new warnings

## Code Style

- **TypeScript strict mode** everywhere. `any` needs an inline comment justifying it.
- **Zod contracts** for anything crossing the API boundary. Never hand-write request/response types.
- **React 18 + hooks**. No class components.
- **CSS lives in `apps/web/src/styles/base.css`**, organized by feature area. Use the existing CSS variable palette (`--bg`, `--surface`, `--surface-border`, `--accent`, `--text`, `--muted`, `--danger`).
- **Dark theme** — bg `#0d1117`, surface `#161b22`, accent `#58a6ff`. Use the CSS variables, not literals.
- **In-app confirmation dialogs**, never browser `confirm()`.
- **Surgical edits** over full-file rewrites — keep diffs small and focused.

## Security-Sensitive Changes

Changes to any of these areas require extra care and a maintainer review:

- Authentication (`apps/api/src/http/controllers/authController.ts`, session middleware)
- MFA and trusted devices (`apps/api/src/domain/auth/authService.ts`)
- Rate limiting (`apps/api/src/http/middleware/loginRateLimiter.ts`)
- IP allowlisting (`apps/api/src/http/middleware/ipAllowlist.ts`)
- Password hashing (never use anything other than bcrypt)
- Session cookie configuration
- CSRF and CSP headers

Don't refactor these in the same PR as a feature change.

## Reporting Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.** Email the maintainer directly or open a private GitHub Security Advisory if the repo supports it.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
