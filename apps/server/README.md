# Public local server and hosting ports

Run `pnpm build:web` then `pnpm start`. The local root binds only to loopback,
protects Host and Origin on reads and writes, opens owner SQLite stores and
maintains encrypted provider credentials outside character memory. No account or
identity vendor is required.

The generic createAPI function accepts a trusted host-injected principal. A
remote host must authenticate before injecting it, partition stores by verified
identity, and apply inference budgets. These operations live outside public App;
this package supplies no Clerk verifier, Workers deployment or hosted quotas.
Laboratory endpoints are denied in cloud mode. The browser receives configuration
and cannot establish a trusted principal. See root README for the public exports.
