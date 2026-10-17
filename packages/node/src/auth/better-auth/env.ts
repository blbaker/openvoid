// Environment parsing for the better-auth mode. See recipes/auth-better-auth for the env vars.
import type { Vars } from '../types.ts';

export type SocialConfig = { clientId: string; clientSecret: string };

export type OidcProviderConfig = {
  /** Provider id used in the URL (GET <basePath>/login/<name>) and as Better Auth's providerId. */
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Claim in the ID token / userinfo response that carries the user's groups. */
  groupsClaim: string;
};

export type BetterAuthModeConfig = {
  baseURL: string;
  secret: string;
  emailAndPassword: boolean;
  google?: SocialConfig;
  github?: SocialConfig;
  oidc: OidcProviderConfig[];
};

const RESERVED_PROVIDER_NAMES = new Set(['google', 'github', 'local', 'credential']);

function required(vars: Vars, name: string): string {
  const value = vars[name]?.trim();
  if (!value) {
    throw new Error(`openvoid: better-auth mode needs ${name}.`);
  }
  return value;
}

function socialPair(vars: Vars, prefix: string): SocialConfig | undefined {
  const clientId = vars[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = vars[`${prefix}_CLIENT_SECRET`]?.trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error(`openvoid: ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must be set together.`);
  }
  return { clientId, clientSecret };
}

/** OPENVOID_AUTH_OIDC_<NAME> with NAME uppercased and non-alphanumerics turned into "_". */
function envPrefixFor(name: string): string {
  return `OPENVOID_AUTH_OIDC_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function parseOidcProviders(vars: Vars): OidcProviderConfig[] {
  const names = (vars.OPENVOID_AUTH_OIDC_PROVIDERS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return names.map((name) => {
    if (RESERVED_PROVIDER_NAMES.has(name.toLowerCase())) {
      throw new Error(`openvoid: OIDC provider name "${name}" is reserved, pick another name.`);
    }
    if (seen.has(name)) throw new Error(`openvoid: OIDC provider name "${name}" listed twice in OPENVOID_AUTH_OIDC_PROVIDERS.`);
    seen.add(name);
    const prefix = envPrefixFor(name);
    const issuer = required(vars, `${prefix}_ISSUER`).replace(/\/+$/, '');
    const clientId = required(vars, `${prefix}_CLIENT_ID`);
    const clientSecret = required(vars, `${prefix}_CLIENT_SECRET`);
    const scopes = (vars[`${prefix}_SCOPES`] ?? 'openid profile email')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const groupsClaim = vars[`${prefix}_GROUPS_CLAIM`]?.trim() || 'groups';
    return { name, issuer, clientId, clientSecret, scopes, groupsClaim };
  });
}

export function parseConfig(vars: Vars): BetterAuthModeConfig {
  const baseURL = required(vars, 'OPENVOID_PUBLIC_URL');
  const secret = required(vars, 'BETTER_AUTH_SECRET');
  return {
    baseURL,
    secret,
    emailAndPassword: vars.OPENVOID_AUTH_EMAIL_PASSWORD !== '0',
    google: socialPair(vars, 'OPENVOID_AUTH_GOOGLE'),
    github: socialPair(vars, 'OPENVOID_AUTH_GITHUB'),
    oidc: parseOidcProviders(vars),
  };
}
