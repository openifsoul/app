# Desktop architecture

The 0.6.0 roadmap packages the App workspace in Electron alongside its local
service and the Minecraft companion. Electron owns the window and the lifecycle
of the local service. The workspace uses the App's existing service and pairing
boundaries. The game owns its mechanics and server configuration.

Each installation keeps writable data in the platform's per-user application
directory. The serialized format remains in the 0.4.0 family. Service location
and model provider are configured independently of memory ownership. Connecting
to a different service leaves memory with its current owner.

macOS Apple silicon installers can enable authenticated Desktop updates. Windows
and Linux updates and independent bridge updates are separate milestones.

## Build and launch

On a development machine, install the App's frozen dependencies and run
`pnpm build:desktop darwin arm64` or `pnpm build:desktop win32 x64`. Add an output
directory as the final argument to write outside `dist/desktop`. A macOS build
produces a disk image on macOS, and a Windows build produces a portable folder.
Copy the app from the disk image to Applications, or keep the Windows folder
together and open **IfSoul.exe**. Electron supplies Node for the local SQLite
service and bundled bridge. Both start as separate owned processes.

Open **Games → Configure Minecraft** and choose **Start and approve companion**.
After granting local approval, enter your trusted server address, select the
online player, character, memory and available model, then save and start the
connection. Ollama and its model are installed separately. You can also use
the service's OpenAI key setting. Minecraft game and server installation are
separate. Closing the window keeps the service and companion running while the
IfSoul menu-bar or tray icon is available. Choose **Open IfSoul** to restore the
same window, or **Quit IfSoul** to shut down the owned processes. On macOS the
Dock icon also restores the window. If the tray is unavailable, closing the
window quits the app.

In **Settings → Runtime Location**, open a self-hosted or managed HTTPS App in
your system browser and sign in there. The desktop window keeps the local App
and its memory open. Remote pages receive no desktop privileges.

## Local process access

The service and companion listen on 127.0.0.1 ports 28788 and 28811, respectively.
Each launch authenticates local traffic with process-scoped credentials. The
sandboxed workspace receives only a limited desktop interface for user-approved
companion startup and opening an HTTPS service. The desktop process retains
companion control credentials. Browser deployments retain the standalone
companion consent and pairing flow.

## Desktop Ollama context budget

For the local `qwen3:8b` tag, Desktop requests an 8,192-token context
window and reserves 2,000 tokens for generation. Prompt packing estimates
input using the UTF-8 byte length of the system message, prompt and schema
serialized together, divided by 1.5 and rounded up, plus 128 tokens of
overhead. The byte ceiling also applies. This is a configured estimate.
Other tags retain their configured or unlisted context behavior.

## Unsigned test downloads

See the [App releases page](https://github.com/openifsoul/app/releases) for
unsigned test builds for macOS (Apple silicon) and Windows x64. The OS may
warn or block installation. Windows native execution remains untested.
Windows test builds use manual updates. The macOS updater needs a compatible newer signed release.

## Desktop updates on Apple silicon

A packaged app with an embedded update trust record checks its HTTPS feed
while the workspace is open. The sidebar offers Update when a newer compatible
release verifies. Save open drafts and end active game connections before
confirming the restart. The update checks its
Ed25519-signed metadata, exact download length and SHA-256, the packaged code integrity seal,
bundle identity, architecture, data format and bundled bridge receipt. The app
checks the candidate's local service, rendered workspace and bundled companion
with a disposable copy of the service data before exchanging the two bundles on the same volume. The original stays
available until the installed candidate starts its own service and renders its
workspace. Failed startup restores it automatically. The next launch recovers a
transaction interrupted after exchange or during startup. The updater requires
the parent of the installed app to allow creating and exchanging its staging
directory. Unsupported permissions and invalid artifacts leave the old app in
place.

Desktop and its bundled companion share an installation receipt. A later
independent bridge installer needs its own update trust and transaction record.
Eligible Desktop builds must read and write data that the previous version can
still use, including startup writes and companion storage. The signed metadata
declares this separately from the format identifier. Release acceptance must
verify backward compatibility against representative stores before signing the
payload. Updates never migrate or restore the owner data directory.

A local packaging integrator can set `IFSOUL_DESKTOP_UPDATE_TRUST_DIR` to a
directory containing a public `update-trust.json` with `feed`, PEM Ed25519
`publicKey` and `distribution: "ifsoul-ed25519-v1"`. The default local build contains no
trust record. The signed feed envelope contains unpadded base64url `payload`
and `signature`. The JSON payload includes `product`, `protocol`, `platform`,
`arch`, `version`, `distribution`, `dataFormat`, `rollbackCompatible`, `expiresAt` (Unix
milliseconds), `artifact` (same-origin DMG URL), `bytes`, `sha256` and
`bridges`. The bridges object is keyed by the stable bridge ID
`minecraft-mineflayer` with `protocol` and `sha256` from the packaged source
receipt. Use product `org.openifsoul.desktop`, protocol 1, platform `darwin`
and architecture `arm64`. Sign the payload bytes as stored before base64url
encoding. Signing and release hosting are separate release operations. The signed
manifest commits to the byte length and SHA-256 of the exact DMG. macOS app
integrity still requires a strict code-signature check. The test bundle has an
ad-hoc integrity seal, without a Developer ID or notarization. macOS may warn
or block installation. Legacy trust records with an Apple signing team keep
that requirement and cannot use the Ed25519 distribution policy.

The web sidebar lists installer links from the build-time
`VITE_IFSOUL_MACOS_DOWNLOAD` and `VITE_IFSOUL_WINDOWS_DOWNLOAD` settings.
Set these to the reviewed HTTPS asset URLs after release hosting is ready.
Unset or malformed links are omitted. With neither set, the sidebar explains
that installers are unavailable and the browser workspace remains usable.

For an isolated command-line launch, set `IFSOUL_DESKTOP_APP_PORT` and
`IFSOUL_DESKTOP_COMPANION_PORT` to distinct available loopback ports, and
pass an explicit `--user-data-dir`. Use the chosen service port in separately
installed bridge configurations. Desktop still requires its own service to
start and authenticate before rendering the workspace.
