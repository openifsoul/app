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
target for a relationship. Each internal model proposal supplies the current
event reference separately from earlier evidence. The App validates both
against the offered IDs before composing the runtime evidence list. Earlier
private evidence must belong to the same interlocutors and authorized worlds. Private claims retain the recorded reporter's ID, including when the
claim attributes an action to somebody else. The resulting revision stores
source IDs, confidence and an explanation
while preserving the original events. The App composes proposal identity and
revisions from inspected runtime state. The model proposes changes and concise
reasons based on the current message and eligible sources. A model chooses a signed
relative magnitude from the offered strengths. The App converts it using the
configured maximum delta, validates the selection, and passes a numeric delta to
Core. A zero magnitude can revise confidence without changing the value.
Runtime validation remains authoritative.

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

In [linked App Conversation](memory.md#continue-as-a-mineflayer-player-in-conversation),
reflection and the reply share the controller deadline. If reflection times
out or returns an unusable proposal, it writes no relationship change. The
reply generation can explain a pending change when its evidence and baseline
sources remain available in context. The proposal shows current and proposed
values and confidences separately from recorded revisions. The proposal stays
pending until the App commits the explained change and companion reply together
after rechecking consent and revisions. The App can proceed with the reply
without a change while there is time and the selected game consent and evidence
scope remain valid. Ordinary App behavior state displays
the ordinary App session's evidence and relationship history. Shared
configuration remains available for its authorized targets.

The unconfigured solitary bridge retains its existing behavior. Mapped configured
bridges must resolve an existing owner-authorized memory identity; equal display
names or imported IDs do not authenticate a participant. Host capabilities,
available choices and adoption/effect reports remain outside editable behavior
configuration.

See [Core contracts and diagrams](https://github.com/openifsoul/core/blob/main/docs/behavior.md)
for precedence, bounds, portable/world scope, explicit decay, operator constraints
and revision fencing. Relationship interpretation and revision are model-dependent;
validation and persistence checks do not establish reliable semantic reassessment.
