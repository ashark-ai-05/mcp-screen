# Contributing

Thanks for helping. Issues and pull requests are welcome.

```bash
npm install
npm run build
npm test              # vitest unit tests
npm run typecheck
npm run screenshots   # end-to-end: a real stdio MCP client, hooks and Playwright (needs `npx playwright install chromium`)
```

- Keep `npm test`, `npm run typecheck` and `npm run screenshots` green, and add a test with each change.
- The browser client in `public/` has no build step. Keep it dependency-free.
- Anything that touches the sandbox, tokens or live sources: read [SECURITY.md](SECURITY.md) first and describe the security impact in the PR.
- Report security problems privately through GitHub Security Advisories, not in public issues.
