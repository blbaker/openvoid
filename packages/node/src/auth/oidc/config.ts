// Parses OPENVOID_PUBLIC_URL and OPENVOID_AUTH_OIDC_* into a validated provider list. Every
// problem throws here, at startup, with the exact env var name that needs fixing: a mode that
// starts with half-working providers is worse than one that refuses to start.
import type { Vars } from '../types.ts';

export type OidcProviderConfig = {
  type: 'oidc';
  name: string;
  label: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  groupsClaim: string;
  issuer: string;
  allowHttp: boolean;
};

export type GithubProviderConfig = {
  type: 'github';
  name: string;
  label: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  groupsClaim: string;
  githubUrl: string;
  githubApiUrl: string;
};

export type ProviderConfig = OidcProviderConfig | GithubProviderConfig;

export type OidcModeConfig = {
  /** OPENVOID_PUBLIC_URL, normalized: absolute, no trailing slash. */
  publicUrl: string;
  providers: ProviderConfig[];
  /** Provider name to run RP-initiated logout against, from OPENVOID_AUTH_OIDC_LOGOUT. */
  logoutProvider: string | null;
};

const PREFIX = 'OPENVOID_AUTH_OIDC_';

function envName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function required(vars: Vars, key: string, hint: string): string {
  const value = vars[key]?.trim();
  if (!value) throw new Error(`openvoid: oidc mode needs ${key} (${hint}).`);
  return value;
}

function absoluteUrl(key: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`openvoid: ${key} must be an absolute URL, got "${value}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`openvoid: ${key} must be http or https, got "${value}".`);
  }
  return url;
}

function splitList(value: string | undefined): string[] | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/[\s,]+/).filter(Boolean);
}

function defaultLabel(name: string, type: 'oidc' | 'github'): string {
  if (type === 'github') return 'GitHub';
  if (name.toLowerCase() === 'google') return 'Google';
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

function parseProvider(vars: Vars, name: string, allowHttp: boolean): ProviderConfig {
  const env = envName(name);
  const prefix = `${PREFIX}${env}_`;
  const typeRaw = vars[`${prefix}TYPE`]?.trim() || 'oidc';
  if (typeRaw !== 'oidc' && typeRaw !== 'github') {
    throw new Error(`openvoid: ${prefix}TYPE must be "oidc" or "github", got "${typeRaw}".`);
  }
  const type = typeRaw;
  const clientId = required(vars, `${prefix}CLIENT_ID`, `the OAuth client id registered for provider "${name}"`);
  const clientSecret = required(vars, `${prefix}CLIENT_SECRET`, `the OAuth client secret for provider "${name}"`);
  const groupsClaim = vars[`${prefix}GROUPS_CLAIM`]?.trim() || 'groups';
  const label = vars[`${prefix}LABEL`]?.trim() || defaultLabel(name, type);

  if (type === 'github') {
    const scopes = splitList(vars[`${prefix}SCOPES`]) ?? ['read:user', 'user:email'];
    const githubUrl = (vars[`${prefix}GITHUB_URL`]?.trim() || 'https://github.com').replace(/\/+$/, '');
    const githubApiUrl = (vars[`${prefix}GITHUB_API_URL`]?.trim() || 'https://api.github.com').replace(/\/+$/, '');
    return { type, name, label, clientId, clientSecret, scopes, groupsClaim, githubUrl, githubApiUrl };
  }

  const issuer = required(vars, `${prefix}ISSUER`, `the OIDC discovery issuer URL for provider "${name}"`);
  const issuerUrl = absoluteUrl(`${prefix}ISSUER`, issuer);
  if (issuerUrl.protocol === 'http:' && !allowHttp) {
    throw new Error(
      `openvoid: ${prefix}ISSUER="${issuer}" is plain http. Use https, or set OPENVOID_AUTH_OIDC_ALLOW_HTTP=1 ` +
        'for a local development provider (e.g. Dex) that does not terminate TLS itself.',
    );
  }
  const scopes = splitList(vars[`${prefix}SCOPES`]) ?? ['openid', 'email', 'profile'];
  if (!scopes.includes('openid')) scopes.unshift('openid');
  return { type, name, label, clientId, clientSecret, scopes, groupsClaim, issuer, allowHttp };
}

export function parseConfig(vars: Vars): OidcModeConfig {
  const publicUrlRaw = required(
    vars,
    'OPENVOID_PUBLIC_URL',
    'the externally reachable base URL of this app, e.g. https://app.example.com',
  );
  const publicUrl = absoluteUrl('OPENVOID_PUBLIC_URL', publicUrlRaw);

  const names = required(
    vars,
    'OPENVOID_AUTH_OIDC_PROVIDERS',
    'a comma-separated list of provider names, e.g. "family,google,github"',
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error('openvoid: OPENVOID_AUTH_OIDC_PROVIDERS must list at least one provider name.');
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`openvoid: OPENVOID_AUTH_OIDC_PROVIDERS names must be letters, digits, "_" or "-", got "${name}".`);
    }
    if (seen.has(name)) throw new Error(`openvoid: OPENVOID_AUTH_OIDC_PROVIDERS lists "${name}" more than once.`);
    seen.add(name);
  }

  const allowHttp = vars.OPENVOID_AUTH_OIDC_ALLOW_HTTP === '1';
  const providers = names.map((name) => parseProvider(vars, name, allowHttp));

  const logoutProvider = vars.OPENVOID_AUTH_OIDC_LOGOUT?.trim() || null;
  if (logoutProvider && !names.includes(logoutProvider)) {
    throw new Error(
      `openvoid: OPENVOID_AUTH_OIDC_LOGOUT="${logoutProvider}" is not one of OPENVOID_AUTH_OIDC_PROVIDERS (${names.join(', ')}).`,
    );
  }

  return { publicUrl: publicUrl.toString().replace(/\/+$/, ''), providers, logoutProvider };
}

export function redirectUri(publicUrl: string, basePath: string, name: string): string {
  return `${publicUrl}${basePath}/callback/${encodeURIComponent(name)}`;
}
