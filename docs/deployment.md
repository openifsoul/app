# Build and deployment policy

Checks and release builds run locally with `pnpm install --frozen-lockfile`,
`pnpm check` and the manifest's build/package commands. Public consumers need no
private repository, account or sibling checkout. Reviewed built tarballs remain
the distribution mechanism; no registry publication is authorized.

## Public CI authorization on 2026-11-08

The owner authorized GitHub Actions checks on `push` and `pull_request` in this
public repository. This narrowly supersedes earlier no-CI/remote-execution rules;
release builds and release validation remain local.
Use GitHub-hosted Linux runners, Node 22.18.0 (within the manifest engine range)
and manifest-pinned pnpm 10.15.0 with frozen-lockfile installation. No secrets,
private checkout, paid model, production environment or self-hosted runner is used.
No deployment, npm publication, schedules, provider builds or settings changes are
authorized. Private Website and Cloud are excluded. Preparing a workflow does not
prove a GitHub run passed; activation awaits a separately authorized commit/push.

## Automated check coverage

`pnpm check` includes types, tooling/boundary tests and service/server/laboratory tests. CI also runs `pnpm build` for server declarations/JavaScript and browser assets.

The workflow is `.github/workflows/checks.yml`: one Ubuntu 24.04 job with a
20-minute timeout and cancellation of superseded runs per event/ref. Only normal
`pull_request` and `push` events run; fork code never runs through
`pull_request_target`. Official checkout/setup-node actions are pinned to full
commit SHAs, checkout does not persist credentials, and token permissions are
limited to `contents: read`. Dependency caching and artifact uploads are disabled.
Registry installation uses public dependencies and reviewed in-repository vendor
archives. CI calls existing manifest gates without changing runtime contracts.

Local validation, GitHub-run results, browser acceptance, real-provider behavior
and production evidence are separate. No remote green result is claimed before
an actual run. Repository/fork approval rules may require an owner to approve a
first contribution; this task does not alter those settings. A public hosted job
uses runner and network resources; no paid providers or larger runners are used.

Deployment remains a separate owner decision. Managed hosting belongs to private
Cloud, using manually invoked Wrangler after local release gates and explicit
release authorization. A push does not deploy. No schedules, automatic publishing,
private Website/Cloud CI or production monitoring are configured by this workflow.
