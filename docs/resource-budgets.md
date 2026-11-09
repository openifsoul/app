# Self-hosted resource policy

The local owner can configure budgets through `IFSOUL_RESOURCE_POLICY_FILE`, an
absolute path to a JSON `AppResourceConfiguration`, before `pnpm start`. No source
edit, account or hosted service is required. This file contains policy, not API
keys. Invalid/unknown configuration fails safely before local data initialization.
Request bodies, query strings, model output and imported history cannot set it.
Managed compositions inject their own trusted policy; omitting it preserves their
existing behavior and quotas.

## Independent layers

| Layer                                         | Local default                                | Owner/meaning                                        |
| --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| HTTP general body                             | 16,384 bytes                                 | Local operator / authenticated server composition    |
| Profile / memory archive body                 | 70,000 / 2,010,000 bytes                     | Separate ingress wrappers                            |
| Bridge envelope                               | 8,000 bytes                                  | SDK-compatible accepted serialized request           |
| Local Ollama packed prompt                    | 10,000 bytes                                 | Packing heuristic, **not** provider/context capacity |
| Other composed packed prompt                  | 21,000 bytes                                 | Existing controller default                          |
| Local Ollama bridge generation                | 50,000 ms                                    | Requested controller deadline                        |
| Local Ollama provider / App runtime / browser | 55,000 / 60,000 / 60,000 ms                  | Separate waits                                       |
| Ollama provider request / response / output   | 200,000 bytes / 100,000 bytes / 2,000 tokens | Core client defaults apart from local wait           |
| App selected memory                           | 100 records / 150,000 bytes                  | Runtime selection, not complete retained history     |
| Reflection input                              | 24 sources / 6,000 bytes                     | Scoped proposal input, not a full archive            |

UTF-8 wire bytes, JavaScript string code units, model input/output tokens, memory
selection and time are different units. `promptBytes` accounts for a structured
request including system text, escaped user JSON and schema. Actual provider
serialization is independently byte-checked. Ten thousand is a historical local
latency heuristic, not an API limit or a target to fill exactly. Neither small
wire size nor a larger configured deadline guarantees valid model completion.

## Example explicit local policy

```json
{
  "http": { "bodyBytes": 65536 },
  "bridge": {
    "maxRequestBytes": 65536,
    "maxContextChars": 4000,
    "timeoutMs": 120000
  },
  "ollama": {
    "promptBytes": 32768,
    "promptCeilingBytes": 32768,
    "generationTimeoutMs": 90000,
    "limits": { "timeoutMs": 95000, "maxOutputTokens": 2000 },
    "ceilings": { "timeoutMs": 95000 },
    "contexts": {
      "your-installed-model": {
        "windowTokens": 16384,
        "source": "operator",
        "estimate": { "bytesPerToken": 2, "overheadTokens": 256 }
      }
    },
    "compactReflection": true,
    "reflectionSourceBytes": 12000,
    "reflectionSources": 24
  },
  "runtime": {
    "limits": { "controllerTimeoutMs": 100000 },
    "ceilings": { "controllerTimeoutMs": 100000 }
  },
  "browserTimeoutMs": 120000
}
```

Replace the model key with an already installed name and choose finite bounds for
the deployment. These are explicit example settings, not hardware autodetection,
a universal recommendation or proof that a machine/model can satisfy them. The
optional estimator is reported as `estimate`; it is not a tokenizer. Available
model `modelMaxTokens` metadata is an additional declared ceiling, distinct from
Ollama's runtime `windowTokens` (`num_ctx`). Unlisted context remains unknown.
Unknown token usage is not zero and no byte/token equality is asserted.

`limits` request resources; `ceilings` explicitly authorize above-legacy Core
configuration. Raising a ceiling alone does not raise use. Generation, provider,
runtime and browser waits must form a coherent chain. Bridge bytes cannot exceed
HTTP ingress. `promptCeilingBytes` permits an explicitly larger controller packing
bound; the old direct controller API keeps its legacy range without that opt-in.
`IFSOUL_OLLAMA_PROMPT_BUDGET_BYTES` is a local prompt-only override, not a way to
change context, output tokens, deadlines or remote quotas.

`compactReflection` is opt-in. It requests at most one optional interpretation,
350-character spoken content, 96-character value and 120-character reason, with
at most two citations and 768 provider output tokens for the combined request. The model may return
`[]` or choose a different interpretation; no relationship/opinion is prescribed.
Normal calls retain the configured general output budget. Trusted stored-update
validation remains at four updates, 160/240 characters, confidence at most 0.75,
exact sources/quotes/subjects and unchanged CAS/isolation. The provider grammar
keeps reported claims and directed beliefs in separate complete typed branches;
a claim cannot use a trust key/player target. A branch with no representable
source-grounded claim is omitted while `[]` remains valid. Lower output limits can
truncate; incomplete output rejects instead of becoming a successful memory.

## Capability, privacy and unsupported messages

`GET /api/resource-policy` exposes safe configured/effective metadata only after
local-origin or authenticated-principal access. It advertises SDK capacity using
`ifsoul-bridge-resource-policy/0.4.0` inside `ifsoul-app-resource-policy/0.4.0` metadata.
It includes no credential, conversation, raw quota counter or authority grant.
The SDK's built-in HTTP transport discovers this at runtime for explicitly
increased limits; absent capability preserves legacy operation and rejects an
unsupported increase. Browser request waits come from trusted runtime config.

HTTP body/header reception waits are independently configurable as
`http.requestTimeoutMs` (65,000 ms default) and `http.headersTimeoutMs`
(10,000 ms default); header reception cannot exceed the body/request reception
wait. They do not measure model generation or increase its deadline.

Native and Fetch ingress check declared size and running chunk bytes before
concatenation/JSON parsing. Overflow returns an exceeded-budget result; native
connections close without draining an unbounded body. Unsupported implementation
or structural-contract capacity is distinct from an exceeded operator budget. The
old API behavior remains when no new policy is injected.

This stage supports bounded **buffered JSON**, at most 64 MiB per serialized
message. It explicitly rejects a 1 GiB request policy before buffering/fetch. It
does not implement a streamed/chunked 1 GiB transport, nor prove that a model can
consume a large HTTP body. Buffered parsing needs additional memory copies.
Current Core conversation input/output remain at 4,000/2,000 characters; larger
transport limits cannot rewrite those schemas. App report windows can be raised
to 128 per request; existing persistent retention remains bounded to 900,000
bridge bytes and a 96,000-byte reflection snapshot. Retained-context omissions are
explicit; a larger request is not a complete memory backup.

See [memory architecture](memory.md), the
[Core policy](https://github.com/openifsoul/core/blob/main/docs/resource-budgets.md)
and [SDK policy](https://github.com/openifsoul/sdk/blob/main/docs/resource-budgets.md).
Local tests use real 32–64 KiB fixtures and small overflow streams; they do not
allocate 64 MiB/1 GiB or claim production/large-machine evidence.
