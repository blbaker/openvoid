// The seam between OpenVoid and Void's runtime.
//
// Void resolves bindings (env.DB, env.KV, ...) from an AsyncLocalStorage that it keeps on
// globalThis under Symbol.for('void.envContext.v1'), plus a per-request resource scope under
// Symbol.for('void.runtimeRequestScope.v1'). Using the same registered symbols means every copy of
// Void's runtime (the bundled one, the dev server's module runner) sees the env we set here.
// test/void-contract.test.ts fails if a Void release renames either symbol.
import { AsyncLocalStorage } from 'node:async_hooks';

const ENV_CONTEXT = Symbol.for('void.envContext.v1');
const REQUEST_SCOPE = Symbol.for('void.runtimeRequestScope.v1');

type Store = { [ENV_CONTEXT]?: AsyncLocalStorage<object>; [REQUEST_SCOPE]?: AsyncLocalStorage<{ resources: Map<object, unknown> }> };
const shared = globalThis as Store;
shared[ENV_CONTEXT] ??= new AsyncLocalStorage();
shared[REQUEST_SCOPE] ??= new AsyncLocalStorage();
const envContext = shared[ENV_CONTEXT];
const requestScope = shared[REQUEST_SCOPE];

/** Run fn with `env` as Void's runtime env, inside a fresh request scope. */
export function runWithEnv<T>(env: object, fn: () => T): T {
  return envContext.run(env, () => requestScope.run({ resources: new Map() }, fn));
}

/**
 * Make `env` the fallback for code that runs outside a request (startup hooks, timers).
 * Void reads globalThis.__env__ when no request env is active.
 */
export function setGlobalEnv(env: object): void {
  (globalThis as { __env__?: object }).__env__ = env;
}
