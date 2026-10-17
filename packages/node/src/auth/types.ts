// The contract every OpenVoid identity mode implements, and the user/session shapes apps see.
// Modes: oidc (OpenID Connect / OAuth 2 sign-in), proxy (trusted headers from a login proxy),
// better-auth (email + password and social sign-in stored in the app database).
import type { SessionStore } from './sessions.ts';

export type AuthUser = {
  /** Stable id: "<provider>:<subject>", e.g. "authelia:7f3a..." or "github:12345". */
  id: string;
  /** Name of the provider or mode that signed the user in, e.g. "google", "authelia", "proxy". */
  provider: string;
  /** The provider's own id for the user (OIDC `sub`, GitHub user id, proxy user name). */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
  /** Group names from the provider (OIDC `groups` claim, proxy groups header). */
  groups: string[];
};

export type AuthSession = {
  id: string;
  user: AuthUser;
  createdAt: number;
  expiresAt: number;
};

export type Vars = Record<string, string | undefined>;

export type AuthHooks = {
  /** Called after a successful sign-in, before the session cookie is set. */
  onSignIn(user: AuthUser): Promise<void>;
};

export type AuthModeContext = {
  vars: Vars;
  /** Void runtime env with OpenVoid bindings (DB, KV, STORAGE, plain vars). */
  env: Record<string, unknown>;
  sessions: SessionStore;
  /** URL path prefix the mode owns, default "/auth". */
  basePath: string;
  hooks: AuthHooks;
  dialect: 'sqlite' | 'postgresql';
};

export interface AuthMode {
  readonly name: string;
  /**
   * Handle a request under basePath (sign-in, callback, sign-out...). Return null for paths the
   * mode does not own; the core then answers 404.
   */
  handle(request: Request): Promise<Response | null>;
  /** Resolve the signed-in session for any other request, or null if anonymous. */
  resolve(request: Request): Promise<AuthSession | null>;
  /** Create the tables or remote state the mode needs. Runs with `migrate` and on start. */
  migrate?(): Promise<void>;
  close?(): Promise<void>;
}

export type CreateAuthMode = (ctx: AuthModeContext) => AuthMode | Promise<AuthMode>;
