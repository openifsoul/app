# Connect Minecraft through the App

The App configures an installed Minecraft companion through a consent-protected local connection. The browser does not install or silently launch native software. The companion initiates outbound requests to your selected IfSoul service; a hosted service never connects directly to your computer.

## Prepare the companion

Install Node22.18–24 and pnpm10.15.0, then run these four commands in a terminal:

```sh
git clone https://github.com/openifsoul/bridge-minecraft-mineflayer.git
cd bridge-minecraft-mineflayer
pnpm install --frozen-lockfile
pnpm companion
```

In an already prepared bridge folder, only the last command is needed for later launches. Open the companion address shown in the terminal, `http://127.0.0.1:8811`. Keep the terminal running while playing. No configuration file, UUID, provider key or token needs manual editing.

## Configure in Games

1. Open the App service you want to use: local, your self-hosted server, or the managed service. Each service owns its own memory. Opening another service does not copy records.
2. Open **Games**, choose **Configure Minecraft** on the Minecraft card, then open the companion consent page. Enter the exact App origin you opened yourself and approve it locally. Copy the displayed single-use code into the App. It expires after five minutes. The App also obtains a single-use owner proof from its authenticated service. The companion verifies that this owner may inspect a saved binding before showing its profile, memory or player details, including when accounts share the same App origin. The App's control session lasts fifteen minutes and is kept only in the current page, not browser storage. If your browser asks for local-network access, approve only the App and companion you intend to connect.
3. Enter the Minecraft host and port independently of the IfSoul App address. This connector uses Java Minecraft1.20.2 and the explicit trusted offline-server mode. Select only a server you own or are authorized to use and trust to report player identities. It does not change server authentication or sign in to a Microsoft account.
4. Choose the bot name and the player to receive private replies. The player must be online. The companion reads the selected player's UUID from the connected server roster; you do not enter a UUID.
5. Choose an owned character profile, memory, and an available provider/model. Approve **private dialogue**. Save the generated configuration and start. The status shows whether private dialogue or explicitly approved gameplay is ready.
6. In Minecraft, send `/tell LumenBot hello`, replacing the bot name if you chose another. Public chat and other players' whispers are ignored. Gameplay is off by default. Enable movement to ask the bot to follow or walk to a nearby point. Enable defense separately to allow engagement with select nearby hostile mobs. Send `/tell LumenBot !ifsoul stop` or `/tell LumenBot !ifsoul wait` to cancel pending and active gameplay immediately.

Provider availability belongs to the selected service. Ollama can run on a service that configures it; own-key providers keep keys in that service's encrypted store; managed inference uses that service's balance and budgets. Game setup carries no provider key and adds no second AI charge. A synthetic scenario is available for a connection check without model inference.

The App saves settings through the authorized companion. Its native service credential is stored in the companion's restricted data directory, not exposed through status or the browser. The default directory is `~/.ifsoul/minecraft`; an operator can set `IFSOUL_COMPANION_DATA_DIR` before launch. Retain it for restart continuity.

```mermaid
sequenceDiagram
  participant Player
  participant App
  participant Companion
  participant Service
  Player->>Companion: Launch and approve exact App origin locally
  Companion-->>Player: Single-use local pairing code
  Player->>App: Enter code and select owned profile/memory/model
  App->>Service: Obtain short-lived owner control proof
  App->>Companion: Redeem local control code and owner proof
  opt Saved native binding
    Companion->>Service: Verify proof owns the stored connection
  end
  App->>Service: Create scoped device grant with explicit consent
  App->>Companion: Save Minecraft settings and one-use service code
  Companion->>Service: Redeem outbound for restricted native credential
  Companion->>Companion: Persist generated settings with restricted permissions
```

## Continuity, stop and revoke

**Stop** disconnects the local game client and cancels pending sends. **Reconnect** creates a fresh game connection while retaining the approved memory. Uncertain sends are not replayed. A service restart preserves its durable participant events. Restarting the companion reads its saved configuration; re-approve the browser control session to manage it.

Reconfiguring the same service, Minecraft target/player, profile and memory to another provider renews the existing connection identity and preserves its private history. Changing the target, profile or memory creates a separate grant. Switching accounts at the same App origin requires a fresh owner proof. If it does not match the saved binding, its private details stay hidden and start/reconnect are blocked; clear it explicitly before approving the other account. Switching App services is explicit: clear the previous local binding before configuring the new service. It does not copy memory. Existing export/import remains an explicit filtered new-identity fork.

The native service credential expires one hour after approval and can be renewed through the App. Renewing invalidates the prior credential. **Revoke** immediately blocks the service grant, including late model completions. **Clear** stops the local client, asks the service to revoke the credential and removes local settings. If the service cannot confirm revocation, the App reports that fact; use the previous service's connection list to revoke it there. An offline service is never described as successfully revoked.

For connection failures, check the selected player is online, the supported version/trust mode, the two independent server addresses, model availability and managed spending limits. No automatic reconnect or paid-request retry loop runs.

## Embedding and security

`GameConnectionPort` is injected into `createAPI` by the authenticated composition. Owner routes list/create/revoke connections and read their authorized history. Native endpoints are separate exact paths under `/api/game/device/`: `redeem`, `owner-proof`, `ready`, `dialogue` and `revoke`. They accept bounded JSON without browser Origin/cookies. A single-use code or scoped bearer authenticates them; caller tenant, host and NPC IDs are never accepted as authority. The owner resolves profile/memory ownership and provider availability before issuing a grant.

The companion binds literal loopback, checks Host, requires local Origin plus CSRF consent, then permits only the approved exact App origin. Browser controls require a separate short-lived bearer and expose no arbitrary command/file API. Service URLs use HTTPS, except explicit loopback HTTP, and redirects are rejected. CSP permits only the fixed loopback companion address in addition to the service's existing origins. Private dialogue uses the existing participant runtime's audience filtering, one-NPC writer and revision/configuration fences.

```mermaid
flowchart LR
  Player[Approved player] --> Bridge[Minecraft bridge]
  Bridge --> Grant[Scoped device request]
  Grant --> Binding[Server-owned identity and memory binding]
  Binding --> Runtime[Participant runtime and behavior policy]
  Runtime --> Scope{Allowed turn scope}
  Scope -->|Speech only| Dialogue[Model reply without action choices]
  Scope -->|Mixed request| Intent[Current utterance intent]
  Intent -->|Affirmative| Plan[Model reply with bounded choices]
  Intent -->|Unclear or no action| Dialogue
  Dialogue --> Fence[App checks grant and configuration revisions]
  Plan --> Fence
  Fence --> Decision{Structured decision}
  Decision -->|Dialogue| Reply[Private client reply]
  Fence --> Memory[Durable private events]
  Decision -->|Gameplay choice| Check[Bridge checks grant and live target]
  Check --> Execute[Bridge executes native action]
  Execute --> Outcome[Bridge reports observed outcome]
  Outcome --> Memory
```

## Operate a self-hosted service

The public Node service can use its existing owner-password/session-cookie authentication independently of IfSoul accounts. Choose a dedicated persistent data directory and a canonical public HTTPS origin; terminate TLS at your proxy and preserve that exact Host header. The HTTP listener defaults to loopback. Do not expose its backend HTTP port directly.

```sh
IFSOUL_DATA_DIR=/srv/ifsoul-data IFSOUL_PUBLIC_ORIGIN=https://ifsoul.example PORT=8788 pnpm start
```

The generated `owner.json` in that directory contains the owner password and encryption key. Keep it private and provide only the owner password to the person signing into that service. The App displays an owner sign-in form and a Sign out control; passwords are not stored in browser storage. Provider keys remain separately encrypted in the service. An operator can explicitly set `IFSOUL_LISTEN_HOST` for a protected proxy/container network; non-loopback listeners require a configured HTTPS public origin. A loopback HTTP public origin is supported for isolated local testing. Invalid origin/listener configuration fails before opening or creating a memory store. Changing the model does not change the data directory; changing service origins never copies it.

Signing out ends the browser owner session. Use Revoke or Clear to end the separately approved native companion grant. Local consent approval pauses an existing local client; reconnect after owner verification.

## Minecraft server-side bridges

| Bridge                                | Pinned Minecraft/runtime                     | Local dialogue acceptance                                             |
| ------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| Citizens 2.0.37 b3763                 | Minecraft 1.21.4, Paper build 232, Java 21   | Native private dialogue                                               |
| Easy NPC 6.0.2                        | Minecraft 1.21.1, NeoForge 21.1.235, Java 21 | Native private dialogue                                               |
| CustomNPCs Unofficial 1.21.1.20251230 | Minecraft 1.21.1, NeoForge 21.1.235, Java 21 | Private reply received by the local modded client and retained in App |
| MineColonies 1.1.1403                 | Minecraft 1.21.1, NeoForge 21.1.235, Java 21 | Private reply received by the local modded client and retained in App |

Gameplay grants authorize bounded actions on each compatible host. Citizens
can walk to or follow the approved nearby player. Easy NPC and CustomNPCs can
walk to the approved nearby player. MineColonies can recall the selected citizen to
its assigned work building. The App requires a fresh owner opt-in and a
matching ready handshake from a compatible bridge with `game-actions` enabled.
The list reports capability availability at the last handshake.

Each server-side pairing grants private dialogue between one approved player
and one NPC. For a mixed dialogue and action request, the App first classifies
the current utterance. Only an affirmative action intent makes the permitted
choices available to the dialogue model. The host checks current authority
before executing a choice, and the App retains the host's observed outcome
for later recall. Stop and revocation fence pending or active work.

In **Games → Configure Minecraft**, select the server software and Minecraft
version, then choose the matching bridge. Mineflayer retains its companion
flow. Citizens, Easy NPC, MineColonies and CustomNPCs-Unofficial require their
matching server-side IfSoul plugin or mod and an operator-selected NPC.

For these server-side bridges, select the owned character, memory and provider,
enter the server-authenticated player UUID and the specific NPC identity, then
approve private dialogue and issue a pairing code. MineColonies uses
`dimension/colony ID/citizen ID` for the NPC. The server operator enters the
one-use code in the bridge's configuration. An authenticated handshake must match
the owner-approved connector, runtime profile, player and NPC before dialogue
is accepted. The App displays the last handshake and grant status. A renewal
fences the old grant and requires a new handshake for the same target.

Install the server-side bridge separately on a compatible server. The App does
not infer which loader or mods a server is using from its address. The selected
runtime filters candidate bridge profiles. The authenticated device's runtime
declaration checks the selected profile; compatibility is verified separately
for each exact server/mod combination.

Desktop can install a reviewed local IfSoul bridge JAR through the connector's
**Install from local JAR** button. Select its exact build and your stopped
server's folder. Desktop verifies the pinned hash and places the JAR in the
expected `plugins` or `mods` directory. Existing files stay in place. Install
upstream mods and set the connector configuration with your server operator.

### Choose actions for the bridge you installed

| Bridge                | Setup and supported player request                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mineflayer            | Enable movement in the App and join as the approved player. Whisper a request to follow or walk to a nearby point. Enable hostile-mob defense separately.                                                                                  |
| Citizens              | Set `game-actions: true` in the bridge configuration. Select the paired NPC and ask privately to follow or come nearby.                                                                                                                    |
| Easy NPC              | Enable `game-actions` for the paired NPC. The approved player must own it. Configure a native travel objective, such as Follow Owner, and adjust it for your setup so ground navigation is idle at connection time. Ask it to come nearby. |
| CustomNPCs Unofficial | Enable `game-actions` and select the paired NPC. Ask it to come nearby.                                                                                                                                                                    |
| MineColonies          | Enable `game-actions` for the selected citizen. Use a loaded citizen with an assigned, loaded workplace nearby. The approved player needs permission to interact with citizens and manage huts. Ask to recall the citizen to work.         |

## Run a Mineflayer group

The local App and Desktop Games pages offer **Mineflayer group** for one
trusted Minecraft Java 1.20.2 server. Create two or three Mineflayer
connections with movement enabled, distinct owned memories, and the same
available provider and model. Give each group member a unique bot name. The
individual grants establish the available profiles, memories and movement
permission. The group needs its own explicit approval to assign work.

Enter a server-verified player name and UUID to allow that player to request
surveys and send private messages. Enable the separate player-absent option
to allow the cadence to continue when that player leaves. An autonomous group
can omit both player fields to run surveys without player dialogue.

Save the displayed configuration to a private JSON file and run
`pnpm group /path/to/group.json` from the Mineflayer bridge checkout on the
same computer as the App service. The setup code expires in five minutes and
is redeemed once. The active host needs a fresh grant after a full disconnection.
The App keeps durable group events separate from individual bridge transcripts.

Send a private Minecraft message to the specific bot for an addressed
conversation. Send `/tell FirstBot !group hello team` to share an input with the
current group. The first bot responds privately to the approved player.
Individual conversation inputs and their replies remain on that actor's
private channel.

Send `/tell FirstBot !group survey` to request a survey with a player present.
The planner assigns one different cardinal direction per member. Each bot's
Mineflayer pathfinder attempts to walk five blocks in that direction at the
current height. The host may decline a movement or report an unreachable
target. The App records the observed outcomes. The host grant permits up to
three planning attempts, with at least 30 seconds between starts. Absent-player
planning follows the same schedule and budget.

```mermaid
flowchart LR
  Individual["Individual profile, memory and movement grants"] --> Approval["Explicit group approval"]
  Approval --> Code["One-use loopback host code"]
  Code --> Host["Mineflayer clients in one world"]
  Host --> Pulse["Current members and player presence"]
  Pulse --> Scheduler["Revision-fenced group scheduler"]
  Scheduler --> Plan["Distinct five-block survey directions"]
  Plan --> Host
  Host --> Outcomes["Per-actor observed outcomes"]
  Approval --> Revoke["Remove one member or stop the group"]
  Revoke --> Scheduler
  Revoke --> Host
```

Use **Remove member** to revoke the selected actor. The previous revision's
assignments stop, the revoked bot disconnects, and the remaining bots stay
online. The new revision preserves the original expiry, next due time and
remaining planning attempts. With one member left the same grant permits a
single-actor survey. Remove the last member or choose **Stop group** to end the
group. The App manages the underlying individual connections separately.
