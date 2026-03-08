# Contributing

Thanks for your interest in Claude Kanban. Contributions are welcome.

## Getting started

```bash
git clone https://github.com/divyamohan1993/claude-kanban.git
cd claude-kanban
cp .env.example .env
pnpm install
pnpm dev    # starts with --watch for auto-reload
```

Open `http://localhost:51777`.

## How to contribute

1. **Fork** the repository
2. **Create a branch** from `main` (`git checkout -b fix/your-fix`)
3. **Make your changes** — keep commits small and focused
4. **Test** — start the server, verify health checks pass, test the feature
5. **Open a PR** against `main`

## What we look for

- Does it work? Start the server, click through the flow.
- Is it simple? Fewer lines > more lines. No premature abstractions.
- Is it safe? No `innerHTML`, no unsanitized inputs, no new dependencies without justification.

## Code style

- `const`/`let`, never `var`
- Pino logger, never `console.log`
- DOM via `el()` helper, never `innerHTML`
- Vanilla JS — no frameworks, no build step
- Files: `kebab-case`. Functions/variables: `camelCase`. Constants: `UPPER_SNAKE_CASE`.

## Adding dependencies

This project has 4 production dependencies. That's intentional. If you want to add a dependency, explain why the problem can't be solved without it. The bar is high.

## Reporting bugs

Use the [bug report template](https://github.com/divyamohan1993/claude-kanban/issues/new?template=bug_report.yml).

## Requesting features

Use the [feature request template](https://github.com/divyamohan1993/claude-kanban/issues/new?template=feature_request.yml).

## Security issues

See [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities.

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
