# App interface

The sidebar opens the workspace sections below. Settings is in the account menu
at the bottom of the sidebar. Help is directly above that menu. Theme selection
and authenticated sign-out are also in the account menu; local account-free use
does not need sign-out.

| Section      | Route             | Contents                                                         |
| ------------ | ----------------- | ---------------------------------------------------------------- |
| Conversation | `/app/chat`       | Conversation with independently selected profile and memory      |
| Characters   | `/app/characters` | Profile table, creation/import and selected profile settings     |
| Memory       | `/app/memory`     | History table, retained evidence and portable-memory tools       |
| Behavior     | `/app/behavior`   | Shared configuration, scoped overrides and state inspection      |
| Games        | `/app/games`      | Searchable game catalog and game-specific connection settings    |
| Balance      | `/app/balance`    | Service-provided balance, prices, estimates, limits and expenses |
| Settings     | `/app/settings`   | Service location, model connection and provider credentials      |
| Laboratory   | `/app/laboratory` | Local synthetic tests and retained request inspection            |

The top breadcrumb shows the current section and selected entity or editor. Its
parent links return to a list or section without discarding the local draft.
Nested views use local UI state within the section route. Refreshing the browser
opens the section's initial view. Long current names are truncated visually while
their full text remains accessible.

## Profiles and histories

Open a Characters row to inspect the profile, choose its connected history or
export the authored profile. Create character opens generation, import, starter
library and manual authoring.

Open a Memory row to inspect that history. Create memory starts a separate
exportable history; importing first previews an archive and creates a separate
fork. These actions do not rewrite existing memory. See [memory](memory.md).

Character, memory, parameter and request lists use shared shadcn/ui table
primitives. Selection menus use shared shadcn/ui components, with search when at
least five options are displayed.

## Synthetic requests

Laboratory is local-only. Choose a memory history, search retained requests or
open New test to select the profile and memory used by the synthetic garden host.
Run test uses the model connection selected in Settings. Synthetic scenario mode
works without a model connection; choosing a connected provider uses that provider.

Opening a request shows its recorded Result, Trace, recalled-memory references
and Debug payload. Inspection uses the selected request's recorded speaker/model metadata.
Request completion is distinct from host acceptance and task outcomes. The
synthetic host does not control a game or an NPC. Memory import/export tools live
on the Memory page; Minecraft pairing and connection controls live under Games.

See [behavior](behavior.md), [game connections](game-connections.md) and
[balance and spending](billing-memory.md) for the corresponding service contracts.
