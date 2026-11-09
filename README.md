# IfSoul App

Experimental self-hostable React, TypeScript and shadcn App for character authoring,
conversation, memory and provider settings. The same UI is composed by managed
hosting through public authentication ports. Local use needs no account, Clerk,
private repository or sibling checkout.

Requires Node 22.18–24 and pnpm 10.15.0. Run locally:

```sh
git clone https://github.com/openifsoul/app.git
cd app
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
archive in `vendor/` makes this checkout independently installable;
no npm publication is implied. UI entrypoints export TypeScript source for Vite/tsx consumers; server entrypoints
export compiled ESM and declarations. Local `start`/`lab` commands use the source
checkout and development toolchain; the archive is not a turnkey CLI installer. Its archive provenance is recorded in
`vendor/README.md`.

Release checks and builds run locally. GitHub Actions checks on push and pull
requests are authorized by the [execution policy](docs/deployment.md); activation
and a passing result require an actual published workflow run. No automatic
publishing, schedules or deployment are configured. Apache-2.0; see LICENSE and NOTICE.

## Memory and continuity

App implements bounded, persistent evidence, extractive episodes and revisable
source-grounded interpretations. Character-to-player relationships continue across
hosts and App chat within one trusted owner store; role claims keep their world
scope. Profiles and selected memory are independent. Models propose updates;
trusted code validates sources and rejects stale writes.

See [memory architecture](docs/memory.md) for the evidence-flow diagram, identity,
reset and retention boundaries. Memory import creates an untrusted filtered fork
with a new identity, not a full backup or same-identity restore. Relationship
interpretation and revision are model-dependent; validation and persistence checks
do not establish reliable semantic reassessment.

By default, local Ollama bridge requests allow 50 seconds for generation, within a 55-second
runtime envelope. Other compositions retain the default 25-second generation
budget and 30-second envelope. A trusted host can pass `generationTimeoutMs`
(1–55000 ms) as the fifth `runBridgeRequest` argument; request bodies cannot
change this limit. SDK hosts using local Ollama should set `requestTimeoutMs`
to 60000 so the host does not cancel a valid local generation early.

Bridge replies follow the latest player question’s language when `language` is
omitted. An SDK integrator may supply an explicit validated BCP 47 `language`
locale; that selection overrides automatic detection. The first-party Playground
omits this option and follows the question.

Local Ollama model prompts use a trusted 10000-byte structured-wire budget to
bound prefill latency. Other providers retain the 21000-byte default. The
direct composition-only `promptBudgetBytes` option keeps its legacy 8000–21000-byte
range. A trusted resource policy can explicitly configure a larger supported
ceiling; browser request bodies cannot raise it. This selects and, when necessary, compacts recalled
context with omission flags while preserving representative worlds and report
attribution. The prompt is a bounded view, not a full backup: durable memory and
owner inspection remain intact. Optional reflection may be deferred when it
cannot fit; the request still makes at most one model call.

The bridge distinguishes user `chat(message)` from host-triggered `speak` scene
context. Host instructions are not user utterances and do not choose a reply
language. Host reactions use the latest actual user utterance for the selected
memory and historical portrayal, across game hosts and App chat; they react to
the new scene rather than answer the old question again. With no retained user
utterance, the character's configured speech language is the fallback. An
explicit SDK `language` selection still takes precedence.

For runtime-only self-host configuration, safe capability metadata, separate byte/token/deadline budgets and unsupported large messages, see [resource budgets](docs/resource-budgets.md). The local 10,000-byte prompt bound is a configurable packing heuristic, not a model/provider limit.

## Compatibility

The current IfSoul format is **0.4.0**. Matching version numbers do not make distinct format families interchangeable.
See [compatibility](docs/compatibility.md) for identifiers, validation and archive semantics.
