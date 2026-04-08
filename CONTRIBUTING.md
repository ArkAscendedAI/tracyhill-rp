# Contributing to TracyHill RP

Thanks for your interest in contributing! This guide will help you get started.

## Ways to Contribute

### Report Bugs
- Open an [issue](https://github.com/ArkAscendedAI/tracyhill-rp/issues) with reproduction steps
- Include your browser, Node.js version, and Docker version

### Write Code
- Bug fixes
- New AI provider integrations
- UI/UX improvements
- Performance improvements

### Improve Documentation
- Setup guides for different environments
- Provider-specific configuration tips
- Deployment tutorials

### Test
- Cross-browser compatibility
- Mobile responsiveness
- AI provider edge cases (streaming, large contexts)

## Development Setup

```bash
git clone https://github.com/ArkAscendedAI/tracyhill-rp.git
cd tracyhill-rp
npm install

# Terminal 1: Vite dev server (hot reload, proxies /api/* to port 3000)
npm run dev

# Terminal 2: Express backend
node server.js
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test thoroughly in a local Docker build
5. Commit with clear, descriptive messages
6. Push to your fork and open a PR

### Commit Messages

Use clear, imperative-mood messages:
- `Add Gemini 2.5 Flash model support`
- `Fix SSE parsing for Anthropic overloaded_error`
- `Add drag-and-drop file attachments`

### Code Style

- **Frontend:** React 18, single-file `App.jsx`, all CSS inline in STYLE constant
- **Backend:** Express.js, compact one-liners where reasonable, atomic file writes
- **Icons:** lucide-react v0.383.0 (check icon availability before using)
- **Dialogs:** In-app confirmation modals, never browser `confirm()`
- **Theme:** Dark theme (bg: #0d1117, surface: #161b22, accent: #58a6ff)

## Security-Related Changes

Changes to authentication, MFA, rate limiting, IP allowlisting, or session management require:
- Comprehensive testing
- Review by a maintainer
- No regressions in existing security measures

## Security Vulnerabilities

If you find a security vulnerability, **do not open a public issue**. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
