# Third-party notices

OpenVoid does not include a copy of Void. It depends on the `void` package from npm and loads
Void's runtime modules from it.

`packages/node/src/codegen.ts` generates a `void/db` module whose structure follows the module
Void generates for the same purpose, including the list of drizzle helpers it re-exports.
`packages/node/src/scope.ts` uses the registered symbol names Void's runtime keeps its
`AsyncLocalStorage` under. Both come from Void:

    Void - https://github.com/voidzero-dev/void
    MIT License
    Copyright (c) 2026-present, Cloudflare, Inc.

"Void" is used here only to describe what OpenVoid works with. OpenVoid is not affiliated with
or endorsed by Cloudflare or VoidZero.
