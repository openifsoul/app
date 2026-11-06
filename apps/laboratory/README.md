# Shared App UI

React + TypeScript + shadcn sidebar-07 with the existing Notion theme and brand.
The local entry mounts App through RuntimeBootstrap. Managed hosts import the
same App and inject authentication through public browser exports; no private
code or Clerk package is required here.

Character authoring, generation review, original templates, profile-only JSON
import/export, conversation, memory and provider settings preserve their existing
HTTP/data forms. Authored biographies are fiction, never lived evidence.
Laboratory planning/evidence is local-only and distinct from main-App chat.

Run `pnpm build:web` and `pnpm start` from the repository root. See the root
README for local persistence, composition exports and validation policy.
