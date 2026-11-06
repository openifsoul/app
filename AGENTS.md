# IfSoul App contributor rules

Read README.md before changing composition. Public files are English; fixtures
must be original and synthetic. Never commit credentials, conversations, local
databases or ignored output. Preserve HTTP/schema/storage compatibility.

Use React + TypeScript + existing shadcn primitives and preserve the current visual
design. Public App requires no private repository, account or Clerk dependency.
Hosted identity, user-store partition, quotas and Workers operations belong in
private cloud composition. Host games own mechanics. Simulator/CLI are local-only;
production workspace imports no simulator implementation.

Run locally: pnpm install --frozen-lockfile, pnpm check, pnpm build:web. No remote
build, CI, schedules, publication or deploy without explicit owner authorization.
Use CodeGraph first only when .codegraph exists. Browser tests are headless with
unique owned sessions, 300000 ms idle timeout when supported and explicit cleanup.
Never close user browsers or another task's session.
