// Resolve a package specifier to its ESM file, starting from a given directory.
// Used to point generated modules at the exact copies of drizzle-orm and Void's runtime that the
// installed `void` package uses, regardless of how the app's node_modules is laid out (pnpm, npm).
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type ExportTarget = string | { [condition: string]: ExportTarget } | null;

function pickTarget(target: ExportTarget, conditions: string[]): string | null {
  if (target === null) return null;
  if (typeof target === 'string') return target;
  for (const [condition, value] of Object.entries(target)) {
    if (conditions.includes(condition)) {
      const found = pickTarget(value, conditions);
      if (found) return found;
    }
  }
  return null;
}

export function packageDir(name: string, fromDir: string): string {
  const require = createRequire(join(fromDir, 'noop.js'));
  let dir = dirname(require.resolve(name));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`openvoid: could not find the package directory of "${name}" from ${fromDir}`);
    dir = parent;
  }
}

/** e.g. resolveEsm('drizzle-orm/d1', voidDir) -> /.../drizzle-orm/d1/index.js */
export function resolveEsm(specifier: string, fromDir: string, conditions = ['node', 'import', 'default']): string {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  const subpath = `.${specifier.slice(name.length)}`;
  const dir = packageDir(name, fromDir);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: Record<string, ExportTarget>; main?: string };
  const target = manifest.exports ? pickTarget(manifest.exports[subpath] ?? null, conditions) : subpath === '.' ? (manifest.main ?? 'index.js') : subpath;
  if (!target) throw new Error(`openvoid: "${specifier}" has no export for conditions ${conditions.join(', ')}`);
  return join(dir, target);
}
