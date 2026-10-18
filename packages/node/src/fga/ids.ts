// Reversible encoding for OpenFGA identifiers.
//
// OpenFGA object/user identifiers accept any non-whitespace string except the three characters
// it reserves for its own syntax: `:` (type separator), `#` (userset separator) and `*` (public
// access). This is documented by trial and error, not a formal grammar: see
// https://github.com/openfga/openfga.dev/issues/883. AuthUser.id is "<provider>:<subject>" and
// the subject comes from the identity provider (an OIDC `sub` claim, a GitHub user id, a proxy
// header), so it can contain any of those reserved characters, whitespace, or non-ASCII text.
//
// Every byte outside a small safe set (ASCII letters, digits, `-`, `.`) is escaped as `_XX`, the
// lowercase hex of that byte. `_` itself is escaped the same way (`_5f`), which is what makes
// decoding unambiguous: a literal `_` in the output always starts an escape.
const SAFE = /[A-Za-z0-9.-]/;

/** user:<id> and group:<name> both go through this before being sent to OpenFGA. */
export function encodeFgaId(raw: string): string {
  if (raw === '') throw new Error('openvoid: fga id must not be empty.');
  const bytes = Buffer.from(raw, 'utf8');
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    out += byte < 128 && SAFE.test(ch) ? ch : `_${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** Inverse of encodeFgaId; mainly useful for tests and for reading ids back out of tuples. */
export function decodeFgaId(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i]!;
    if (ch === '_') {
      const hex = encoded.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) {
        throw new Error(`openvoid: invalid fga id escape at offset ${i} in "${encoded}".`);
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      const code = ch.codePointAt(0)!;
      if (code > 127) throw new Error(`openvoid: invalid fga id "${encoded}": unescaped non-ASCII character.`);
      bytes.push(code);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
