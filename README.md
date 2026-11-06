# IfSoul App

Experimental self-hostable React, TypeScript and shadcn App for character authoring,
conversation, memory and provider settings. The same UI is composed by managed
hosting through public authentication ports. Local use needs no account, Clerk,
private repository or sibling checkout.

Requires Node 22.18–24 and pnpm 10.15.0. Run locally:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build:web
pnpm start
```

Open http://127.0.0.1:8788. Synthetic scenario mode works without a model. Connect
an OpenAI key in Settings or run Ollama locally (default `http://127.0.0.1:11434`).
Provider credentials are encrypted separately from character memory. Local data
is stored in `.local/server`; `IFSOUL_DATA_DIR` selects another directory and
`PORT` selects the loopback port. Preserve this directory when upgrading. The
server rejects foreign Host/Origin requests. It intentionally listens only on
loopback; remote hosting must supply verified authentication and trusted storage
composition rather than expose this local server.

`pnpm lab demo --db .local/lab.sqlite` runs the separate synthetic-host CLI.
Laboratory routes are local-only. Games own movement, combat and authoritative
outcomes; IfSoul supplies bounded proposals and dialogue.

## Composition exports

`@ifsoul/app/browser` exports the shared App, RuntimeBootstrap and explicit
RuntimeAuthContext/token/theme ports. The hosting application injects its
`cloudAuth` component; App contains no Clerk dependency. Optional
`RuntimeAuth.playgroundHref` navigation is supplied only by hosts that own a playground. Import
`@ifsoul/app/styles.css` once. Named `@ifsoul/app/ui/*` exports are the shared
primitives needed by the first-party website. `@ifsoul/app/server` exports generic
HTTP API, security helpers, character workspace and model controllers. Hosting
owns authentication, per-user storage routing, owner-funded quotas and assets.
It must verify identity before passing a trusted `access.kind = "principal"`.

Core is consumed through the versioned public `@ifsoul/core` exports. The reviewed
prerelease archive in `vendor/` makes this checkout independently installable;
no npm publication is implied. This experimental package currently exports
TypeScript source for Vite/tsx consumers. Its archive provenance is recorded in
`vendor/README.md`.

Checks and builds run locally. There is no CI, automatic publishing, scheduled
execution or deployment configured. Existing production remains untouched by this
repository extraction. Apache-2.0; see LICENSE and NOTICE.
