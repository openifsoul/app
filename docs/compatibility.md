# Format reference

IfSoul 0.4.0 uses exact family identifiers:

| Family                                        | Identifier                            |
| --------------------------------------------- | ------------------------------------- |
| Core protocol and ModelProvider specification | `0.4.0`                               |
| Bridge request                                | `ifsoul-bridge/0.4.0`                 |
| Bridge resource capability                    | `ifsoul-bridge-resource-policy/0.4.0` |
| App resource capability                       | `ifsoul-app-resource-policy/0.4.0`    |
| App memory archive                            | `ifsoul-app-memory/0.4.0`             |

Validators check family, kind and shape without coercion. Matching release
numbers do not make distinct families interchangeable. Callable ModelProvider
clients are runtime APIs, separate from the serialized specification.

Memory import creates an untrusted filtered fork with a new identity, not a full
backup or same-identity restore. Imported data grants no execution authority.
Relationship interpretation and revision are model-dependent. Current validation
and persistence checks do not establish reliable semantic reassessment.
Hosted inference is bounded by configured per-user and shared quotas. Local
cancellation does not guarantee that provider-side work or charges have stopped.

Package release **0.5.0** preserves these compatible **0.4.0** format families.
Package versions identify shipped code; format identifiers validate serialized
records and wire messages independently. Existing records are not relabeled.
