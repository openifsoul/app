# Trusted participant sessions

`@ifsoul/app/server` exports `createParticipantSessionService` and
`createSQLParticipantStore`. This composition API uses the public Core session
domain and SDK `SessionHostPort`. Hosting authenticates the principal and host
before constructing it; request bodies cannot supply trusted access or identity
mappings. A host transport must enforce that same boundary before forwarding
calls. The local solitary bridge remains available unchanged.

```ts
import {
  createParticipantSessionService,
  createSQLParticipantStore,
} from "@ifsoul/app/server";
import { createSessionClient } from "@ifsoul/adapter-sdk";

const service = createParticipantSessionService({
  store: createSQLParticipantStore(driver),
  access: verifiedHostAccess,
  resolveParticipant: (subject) => verifiedIdentityDirectory.resolve(subject),
  controller: async (input, signal) => boundedController(input, signal),
});
service.register(verifiedNpcSubject);
service.register(verifiedPlayerSubject);
const client = createSessionClient(service.port);
await client.transition({
  transitionId: "join-1",
  expectedRevision: 0,
  session,
});
await client.append(addressedPlayerEvent);
const proposal = await client.converse({ ticket, outputEventId: "reply-1" });
```

Here `driver` is the host-owned synchronous transactional SQLDriver. It owns database
lifecycle. The composition creates its own table and partitions state by verified
principal. It does not open a database, select an account, expose an HTTP route,
or load personal data. Only successful transactions commit. The controller receives
only prefiltered trigger/evidence and a timeout signal. The service rejects late
results even if the controller ignores cancellation. Local cancellation does not
guarantee provider work or charges have stopped.

A ticket pins the NPC, trigger, session revision and explicit output recipients
and observers. Repeating a completed identical ticket/output ID returns the
recorded proposal without another controller invocation. Concurrent unfinished
work for the same persistent NPC rejects across sessions. Membership changes fence
old results; no new audience is granted by a model response. Proposals do not
establish delivery, adoption or actual effects.

`service.relationshipEvidence(sessionId, npcId, playerId)` exposes authorized
persistent source events keyed by the two verified participant IDs. This is
source evidence rather than a new model-derived relationship interpretation.
Use the session's trusted `recallWorldIds` to select cross-world continuity.
The server's existing solitary bridge reflection remains a separate consumer.
See [Core session contracts](https://github.com/openifsoul/core/blob/main/docs/sessions.md)
for visibility, transition and writer rules.

Run the complete synthetic two-NPC/two-player host from a standalone App checkout:

```sh
pnpm exec tsx apps/runtime-host/src/session-demo.ts
```

The [executable example](../apps/runtime-host/src/session-demo.ts) supplies actual
verified-directory fixtures, typed members/channels, addressed events and tickets.
It uses an in-memory SQLite database and deterministic controller, asserts that
NPC B receives no NPC A private secret, and closes its own database afterward.

See [group planning and autonomous cadence](group-scheduler.md) for the additive planning API.
