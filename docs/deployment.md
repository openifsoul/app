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
