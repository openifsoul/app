# Shared behavior editor and service

The Behavior section edits the same versioned configuration used by SDK hosts.
It provides parameter definitions/bounds/decay, independent general/provocation
reaction switches, goals, NPC/group/world overrides, operator locks and per-NPC
state/history inspection. Save uses the loaded revision; conflicting edits keep
the draft and offer reload. Changing configuration never resets memory/history.

## Using the editor

The configuration is shared by the workspace; it is not a separate configuration
for every character/profile-memory pair. Open **Behavior** and choose Parameters,
Reactions, Goals, Overrides, or State & history. Parameter rows open one editor at
a time. Save and Reload apply to the shared draft across these sections. Reaction
groups use labeled fieldsets; scoped overrides select a world, group, or NPC.
State inspection selects a session and NPC from the service's authorized catalog.
The breadcrumb returns to the parameter list without discarding unsaved edits.

## API

The authenticated API exposes:

| Method and path                                   | Operation                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/behavior?characterId=...`               | Owner configuration, constraints and verified context catalog      |
| `PUT /api/behavior`                               | `{ expectedRevision, config }`, returning the saved owner snapshot |
| `GET /api/behavior/state?sessionId=...&npcId=...` | Explicit authorized owner state/history inspection                 |

It uses existing same-origin/authentication and bounded-body checks. Owner
configuration requires the injected tenant-owner capability; ordinary host IDs
or body fields grant no owner rights. Conflicts/stale edits return 409, denied
changes 403 and invalid documents 400. Other compositions must inject their own
verified principal and store; the editor reports an unavailable API rather than
creating another configuration copy.

`createBehaviorService` composes the existing SQL participant store and public
Core runtime. Its typed `port` is consumed by SDK `createBehaviorClient` and the
App API. Host `observe` accepts existing trusted identities/addressed events and
an explicit category. The deterministic initial rules update the trust,
cooperation and caution presets; `createBehaviorModelProposer` uses the existing
ModelClient port for bounded evidence-linked relationship or transient-state
deltas. Parameter-specific schemas omit a target for state and require a verified
target for a relationship. Runtime validation remains authoritative.

The local App binds character memory ownership through its verified
CharacterWorkspace, independently of profile names and game embodiments. Explicitly
saved configuration enables the shared behavior path for App conversation and
mapped legacy bridge requests. The host classifier tags known provocation/helpful
phrases; other messages are observations. Trusted SDK hosts may supply categories
directly. Host scene instructions are not player utterances.

Configured reaction policy is checked before model invocation. Provocations can
remain host evidence, update individual relations and produce the protocol's
`no-output` response without a model call. Definitive bridge authentication/policy
rejections do not become SDK fallback speech. Allowed generation receives bounded
current authorized behavior state/goals; old bridge reflection is not injected
wholesale into that configured path. Existing stored reflection/evidence remains
intact; there is no implicit data conversion or relabeling.

The unconfigured solitary bridge retains its existing behavior. Mapped configured
bridges must resolve an existing owner-authorized memory identity; equal display
names or imported IDs do not authenticate a participant. Host capabilities,
available choices and adoption/effect reports remain outside editable behavior
configuration.

See [Core contracts and diagrams](https://github.com/openifsoul/core/blob/main/docs/behavior.md)
for precedence, bounds, portable/world scope, explicit decay, operator constraints
and revision fencing. Relationship interpretation and revision are model-dependent;
validation and persistence checks do not establish reliable semantic reassessment.
