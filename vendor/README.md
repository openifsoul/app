# Built dependencies

The active Core and SDK0.5.0 archives are selected by digest paths in package.json.
`core-participants-receipt.json` and `sdk-participants-receipt.json` record their
exact archive hashes, base commits and source-file inventories. Verify each
archive against its receipt before installing. Public package exports are used
without adjacent source checkouts. Local candidate artifacts do not imply registry
publication. Original0.4 release archives and receipts remain preserved unchanged.

Package release0.5.0 retains compatible0.4.0 serialized/wire families; package
versions and stored-data identifiers are separate.
