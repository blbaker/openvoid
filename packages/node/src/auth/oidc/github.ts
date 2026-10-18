// GitHub's sign-in is plain OAuth 2, not OpenID Connect: no discovery document, no ID token.
// The three endpoints below are overridable (OPENVOID_AUTH_OIDC_<NAME>_GITHUB_URL/_GITHUB_API_URL)
// so tests can point this at a local mock instead of github.com.
import type { GithubProviderConfig } from './config.ts';

export type GithubUser = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
  /** GitHub's OAuth API has no concept of groups. */
  groups: string[];
};

export function githubAuthorizationUrl(cfg: GithubProviderConfig, params: { redirectUri: string; state: string }): string {
  const url = new URL(`${cfg.githubUrl}/login/oauth/authorize`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', cfg.scopes.join(' '));
  url.searchParams.set('state', params.state);
  return url.toString();
}

async function fetchJson<T>(url: string, init: RequestInit, what: string): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`openvoid: GitHub ${what} failed with HTTP ${res.status}. ${body.slice(0, 200)}`.trim());
  }
  return (await res.json()) as T;
}

export async function githubExchangeCode(
  cfg: GithubProviderConfig,
  params: { code: string; redirectUri: string },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });
  const data = await fetchJson<{ access_token?: string; error?: string; error_description?: string }>(
    `${cfg.githubUrl}/login/oauth/access_token`,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    'token exchange',
  );
  if (!data.access_token) {
    throw new Error(`openvoid: GitHub token exchange did not return an access token (${data.error ?? 'no error given'}: ${data.error_description ?? ''})`.trim());
  }
  return data.access_token;
}

type GithubApiUser = { id: number; login: string; name: string | null; avatar_url: string | null };
type GithubEmail = { email: string; primary: boolean; verified: boolean };

export async function githubFetchUser(cfg: GithubProviderConfig, accessToken: string): Promise<GithubUser> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    // GitHub's API rejects requests without a User-Agent.
    'user-agent': 'openvoid',
  };
  const user = await fetchJson<GithubApiUser>(`${cfg.githubApiUrl}/user`, { headers }, 'user lookup');

  let email: string | null = null;
  let emailVerified = false;
  if (cfg.scopes.includes('user:email') || cfg.scopes.includes('user')) {
    const emails = await fetchJson<GithubEmail[]>(`${cfg.githubApiUrl}/user/emails`, { headers }, 'email lookup');
    const primary = emails.find((e) => e.primary) ?? emails.find((e) => e.verified);
    if (primary) {
      email = primary.email;
      emailVerified = primary.verified;
    }
  }

  return {
    subject: String(user.id),
    email,
    emailVerified,
    name: user.name ?? user.login,
    image: user.avatar_url ?? null,
    groups: [],
  };
}
