// The OpenID Connect side of oidc mode, on top of openid-client v6: discovery at startup,
// building the authorization URL, and the callback's authorization code + PKCE grant.
import * as client from 'openid-client';
import { groupsFrom } from './util.ts';
import type { OidcProviderConfig } from './config.ts';

export async function discoverOidcClient(cfg: OidcProviderConfig): Promise<client.Configuration> {
  const options: client.DiscoveryRequestOptions = {};
  if (cfg.allowHttp) options.execute = [client.allowInsecureRequests];
  try {
    return await client.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret, undefined, options);
  } catch (error) {
    throw new Error(
      `openvoid: discovery of OIDC provider "${cfg.name}" at ${cfg.issuer} failed: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

export function oidcAuthorizationUrl(
  config: client.Configuration,
  params: { redirectUri: string; scopes: string[]; state: string; nonce: string; codeChallenge: string },
): string {
  return client
    .buildAuthorizationUrl(config, {
      redirect_uri: params.redirectUri,
      scope: params.scopes.join(' '),
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      state: params.state,
      nonce: params.nonce,
    })
    .toString();
}

export type OidcSignIn = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
  groups: string[];
  /** Kept to support RP-initiated logout later (id_token_hint); null if the provider omitted it. */
  idToken: string | null;
};

export async function oidcExchange(
  config: client.Configuration,
  cfg: OidcProviderConfig,
  params: { callbackUrl: URL; codeVerifier: string; state: string; nonce: string },
): Promise<OidcSignIn> {
  const tokens = await client.authorizationCodeGrant(config, params.callbackUrl, {
    pkceCodeVerifier: params.codeVerifier,
    expectedState: params.state,
    expectedNonce: params.nonce,
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw new Error(`openvoid: OIDC provider "${cfg.name}" did not return a usable ID token.`);

  let userinfo: client.UserInfoResponse | undefined;
  if (config.serverMetadata().userinfo_endpoint && tokens.access_token) {
    userinfo = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
  }

  const groupsRaw = claims[cfg.groupsClaim] ?? userinfo?.[cfg.groupsClaim];
  return {
    subject: claims.sub,
    email: (claims.email as string | undefined) ?? userinfo?.email ?? null,
    emailVerified: Boolean(claims.email_verified ?? userinfo?.email_verified ?? false),
    name: (claims.name as string | undefined) ?? userinfo?.name ?? null,
    image: (claims.picture as string | undefined) ?? userinfo?.picture ?? null,
    groups: groupsFrom(groupsRaw),
    idToken: tokens.id_token ?? null,
  };
}

/** An RP-Initiated Logout URL, or null when the provider does not advertise end_session_endpoint. */
export function endSessionUrl(
  config: client.Configuration,
  params: { idTokenHint?: string | null; postLogoutRedirectUri: string },
): string | null {
  if (!config.serverMetadata().end_session_endpoint) return null;
  const parameters: Record<string, string> = { post_logout_redirect_uri: params.postLogoutRedirectUri };
  if (params.idTokenHint) parameters.id_token_hint = params.idTokenHint;
  return client.buildEndSessionUrl(config, parameters).toString();
}
