// A lazily created OpenFGA client plus the resolved store id, one per distinct configuration
// (in practice one per process: the config comes from env vars, which do not change at runtime).
import { CredentialsMethod, OpenFgaClient, type UserConfigurationParams } from '@openfga/sdk';
import type { Vars } from '../auth/types.ts';

export type FgaContext = { client: OpenFgaClient; storeId: string };

const DEFAULT_STORE = 'openvoid';

function credentials(vars: Vars): UserConfigurationParams['credentials'] {
  const token = vars.OPENVOID_FGA_API_TOKEN;
  const clientId = vars.OPENVOID_FGA_CLIENT_ID;
  if (token && clientId) {
    throw new Error('openvoid: set OPENVOID_FGA_API_TOKEN or OPENVOID_FGA_CLIENT_ID for OpenFGA credentials, not both.');
  }
  if (token) return { method: CredentialsMethod.ApiToken, config: { token } };
  if (clientId) {
    const clientSecret = vars.OPENVOID_FGA_CLIENT_SECRET;
    const apiTokenIssuer = vars.OPENVOID_FGA_API_TOKEN_ISSUER;
    const apiAudience = vars.OPENVOID_FGA_API_AUDIENCE;
    if (!clientSecret || !apiTokenIssuer || !apiAudience) {
      throw new Error(
        'openvoid: OPENVOID_FGA_CLIENT_ID needs OPENVOID_FGA_CLIENT_SECRET, OPENVOID_FGA_API_TOKEN_ISSUER and ' +
          'OPENVOID_FGA_API_AUDIENCE (client credentials, e.g. Okta FGA).',
      );
    }
    return { method: CredentialsMethod.ClientCredentials, config: { clientId, clientSecret, apiTokenIssuer, apiAudience } };
  }
  return undefined;
}

function configKey(vars: Vars): string {
  return JSON.stringify([
    vars.OPENVOID_FGA_URL,
    vars.OPENVOID_FGA_STORE,
    vars.OPENVOID_FGA_STORE_ID,
    vars.OPENVOID_FGA_MODEL_ID,
    vars.OPENVOID_FGA_API_TOKEN,
    vars.OPENVOID_FGA_CLIENT_ID,
    vars.OPENVOID_FGA_CLIENT_SECRET,
    vars.OPENVOID_FGA_API_TOKEN_ISSUER,
    vars.OPENVOID_FGA_API_AUDIENCE,
  ]);
}

function rawClient(vars: Vars): OpenFgaClient {
  return new OpenFgaClient({
    apiUrl: vars.OPENVOID_FGA_URL!,
    authorizationModelId: vars.OPENVOID_FGA_MODEL_ID || undefined,
    credentials: credentials(vars),
  });
}

/** Store names are not guaranteed unique in OpenFGA; pick the oldest match deterministically. */
async function findStore(client: OpenFgaClient, name: string): Promise<{ id: string } | null> {
  const { stores } = await client.listStores({ name });
  const matches = stores.filter((s) => s.name === name);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn(`[openvoid] fga: ${matches.length} stores named "${name}"; using the oldest. Set OPENVOID_FGA_STORE_ID to be explicit.`);
  }
  return matches.slice().sort((a, b) => a.created_at.localeCompare(b.created_at))[0]!;
}

async function resolveStoreId(client: OpenFgaClient, vars: Vars, createIfMissing: boolean): Promise<string> {
  if (vars.OPENVOID_FGA_STORE_ID) return vars.OPENVOID_FGA_STORE_ID;
  const name = vars.OPENVOID_FGA_STORE || DEFAULT_STORE;
  const found = await findStore(client, name);
  if (found) return found.id;
  if (!createIfMissing) {
    throw new Error(`openvoid: no OpenFGA store named "${name}" exists yet. Run \`node dist/ssr/index.js migrate\` (or set OPENVOID_FGA_STORE_ID).`);
  }
  const created = await client.createStore({ name });
  console.log(`[openvoid] fga: created store "${name}" (${created.id})`);
  return created.id;
}

async function buildContext(vars: Vars, createIfMissing: boolean): Promise<FgaContext> {
  const client = rawClient(vars);
  const storeId = await resolveStoreId(client, vars, createIfMissing);
  // Several client methods (notably readLatestAuthorizationModel) only read client.storeId and
  // do not accept a per-call override, so every context sets it once here.
  client.storeId = storeId;
  return { client, storeId };
}

const contexts = new Map<string, Promise<FgaContext>>();

function requireConfigured(vars: Vars, caller: string): void {
  if (!vars.OPENVOID_FGA_URL) throw new Error(`openvoid: ${caller} needs OPENVOID_FGA_URL to be set.`);
}

/** Used by check/listObjects/grant/revoke/onSignIn. Throws a clear error if no store exists yet. */
export function fgaContext(vars: Vars): Promise<FgaContext> {
  requireConfigured(vars, 'fga');
  const key = configKey(vars);
  let ctx = contexts.get(key);
  if (!ctx) {
    ctx = buildContext(vars, false);
    contexts.set(key, ctx);
  }
  return ctx;
}

/** Used by migrateFga: creates the store if missing, and refreshes the cache other calls share. */
export async function fgaMigrateContext(vars: Vars): Promise<FgaContext> {
  requireConfigured(vars, 'migrateFga');
  const ctx = await buildContext(vars, true);
  contexts.set(configKey(vars), Promise.resolve(ctx));
  return ctx;
}

/** Test only: forget cached clients and resolved store ids. */
export function resetFgaContextCache(): void {
  contexts.clear();
}
