# Notes for coding agents

- Read README.md and CONTRIBUTING.md first.
- Node.js 24.21+ is required (Void's minimum). Use pnpm.
- `packages/node/src/scope.ts` is the one place that depends on Void internals (registered
  symbol names). `test/void-contract.test.ts` guards it; run it after any `void` upgrade.
- Every backend change needs the conformance suite green against the real service:
  `scripts/services.sh up`, then `eval "$(scripts/services.sh env)"; pnpm test`.
- Recipe changes need their `scripts/e2e.sh` scenario green.
- Keep files under 300 lines. No silent fallbacks: unsupported options throw.
