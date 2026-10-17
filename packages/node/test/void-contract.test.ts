// Contract with the installed `void` package: its real runtime modules (void/kv, void/storage,
// void/_env) must see the env that OpenVoid sets. This is the test that breaks first if a Void
// release changes the env seam (see src/scope.ts).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEnv, closeEnv } from '../src/env.ts';
import { runWithEnv } from '../src/scope.ts';
import { resolveEsm } from '../src/resolve.ts';

const here = join(import.meta.dirname, '..');
const load = async <T>(specifier: string) => (await import(pathToFileURL(resolveEsm(specifier, here)).href)) as T;

describe('Void runtime contract', () => {
  it('void/kv, void/storage and void/_env read OpenVoid bindings', async () => {
    const { kv } = await load<{ kv: { put(k: string, v: unknown): Promise<void>; get<T>(k: string): Promise<T | null> } }>('void/kv');
    const { storage } = await load<{ storage: { put(k: string, v: string): Promise<unknown>; get(k: string): Promise<{ text(): Promise<string> } | null> } }>('void/storage');
    const voidEnv = await load<{ requireRuntimeBinding(name: string): unknown; getRuntimeBinding(name: string): unknown }>('void/_env');

    // Negative control: outside OpenVoid's scope Void must refuse, which proves the calls below
    // really go through Void's own binding lookup.
    await assert.rejects(() => kv.get('x'), /env|binding/i);

    const env = createEnv({
      dialect: 'sqlite',
      vars: { OPENVOID_DATA_DIR: mkdtempSync(join(tmpdir(), 'ov-contract-')), GREETING: 'hello' },
    });
    try {
      await runWithEnv(env, async () => {
        await kv.put('user:1', { name: 'Doc' });
        assert.deepEqual(await kv.get('user:1'), { name: 'Doc' });
        await storage.put('a.txt', 'flux');
        assert.equal(await (await storage.get('a.txt'))!.text(), 'flux');
        assert.equal(voidEnv.getRuntimeBinding('GREETING'), 'hello');
        assert.ok(voidEnv.requireRuntimeBinding('DB'));
      });
    } finally {
      await closeEnv(env);
    }
  });
});
