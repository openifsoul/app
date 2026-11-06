# Runtime host composition

The character workspace injects public Core runtime, memory and provider ports.
Its default context preserves existing identities and data compatibility. It has
no simulator implementation imports. The generic service retains local synthetic
planning behind server guards; hosted composition cannot enable laboratory routes.

The separate CLI laboratory composes the local simulator explicitly:

```sh
pnpm lab demo
pnpm lab inspect --json
pnpm lab chat --message "What did you complete?"
```

Use `--db <path>` for isolated local data. The default is
`.local/lab/ifsoul.sqlite`. Database handles close in finally blocks. The synthetic
host owns its outcomes; providers supply bounded proposals. Actual games own
mechanics. See the root README for checks and hosting ports.
