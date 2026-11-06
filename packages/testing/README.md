# Local testing helpers

Bounded CLI subprocess invocation and temporary synthetic-data cleanup for
`pnpm test`. Production code does not import these helpers. Core's own tests and
normative fixtures live with Core; this repository tests App composition and the
local simulator without cloud credentials.
