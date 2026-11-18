# Build and checks

Use the Node engine range and pinned pnpm version from package.json:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Use the package manifest for available build and development commands.
Public packages install without private repositories or adjacent source checkouts.
GitHub Actions runs the existing gates on push and pull requests with a frozen
lockfile and public dependencies. It does not deploy or publish packages.

## Standalone local package

Build the server and browser assets before packing the local App:

```sh
pnpm build
pnpm pack
```

The archive includes the built server and web assets. From the extracted
package directory, run `node dist/server/apps/server/src/local.js`. Set
`IFSOUL_DATA_DIR` to a separate persistent directory. The loopback App
serves both its JSON API and the Games and Laboratory pages.
