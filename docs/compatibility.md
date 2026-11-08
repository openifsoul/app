# IfSoul 0.3.0 compatibility

All current IfSoul package manifests, format writers and reviewed composition
artifacts use the common release **0.3.0**. Each checkout carries `release.json`;
`pnpm check:version` verifies its manifest and direct IfSoul artifact pins.
Public consumers need neither a private repository nor a sibling source checkout.

While 0.x, patch releases contain compatible fixes and minor releases may break
contracts. Version 1.0 requires an explicit stable-contract/support decision.
Alpha/beta channels require an explicit decision and are not the default.

| Family                         | Current writer            | Accepted legacy input                                                                         |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------- |
| Core document schemas          | `0.3.0`                   | `draft-0.2.0`, validated without mutating stored records                                      |
| Historical Core schemas        | No current writer         | Frozen v0.1 structural fixtures remain; no generic semantic upgrade                           |
| ModelProvider normative schema | `0.3.0` specification     | Historical v0.1 specifications retained; callable clients are not a serialized wire transport |
| Bridge request                 | `ifsoul-bridge/0.3.0`     | `ifsoul-bridge/0.1` through exact request validation                                          |
| Resource capability            | Family name plus `/0.3.0` | Explicit legacy bridge capability adapter with unchanged ceilings                             |
| App filtered-fork memory       | `ifsoul-app-memory/0.3.0` | `ifsoul-app-memory/0.1`, original checksum and shape validated before import                  |

Bridge responses retain their original unversioned shape. New servers accept
legacy/current requests; SDK can explicitly select legacy mode. A current client
against an old rejecting server reports an actionable compatibility error without
hidden retry/downgrade or model calls. Unsupported versions and wrong families
reject. Capability metadata grants no authority and cannot increase trusted limits.

New current schemas sit beside immutable historical schemas/examples. A typed
copy adapter supports reviewed shape-preserving v0.2 documents; general archive
manifest conversion requires an explicit file/checksum rebuild and is rejected
by the generic adapter. App archives remain a separate filtered-fork family,
not a full backup or same-identity restore. Imports preserve provenance/losses,
create new identities and confer no execution rights. Existing stored evidence
is not silently rewritten. Substantive model relationship reassessment remains
an open quality gap; a coordinated version does not establish model reliability.
