// migrateFga: create the store if needed, then write fga/model.fga as a new authorization model
// version only when it actually changed. Safe to run on every deploy.
import { transformer } from '@openfga/syntax-transformer';
import type { AuthorizationModel, WriteAuthorizationModelRequest } from '@openfga/sdk';
import type { Vars } from '../auth/types.ts';
import { fgaMigrateContext } from './client.ts';

type ModelBody = Omit<AuthorizationModel, 'id'>;

// Deep, key-order-independent canonicalization so a model read back from the server compares
// equal to the one we are about to write. The server fills in fields the DSL transformer leaves
// absent (empty `condition`/`module` strings, null `source_info`, an empty top-level
// `conditions` map, an empty `object` on a computed userset) with their zero values, so those are
// treated as "not set" and dropped from both sides before comparing.
function isEmptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const raw = (value as Record<string, unknown>)[key];
      if (raw === '' || raw === null) continue;
      const normalized = canonicalize(raw);
      if (isEmptyObject(normalized)) continue;
      out[key] = normalized;
    }
    return out;
  }
  return value;
}

// type_definitions is an array; the server is free to return it in a different order than we
// sent it, so sort by type name before comparing. Relations inside a type are a map, so their
// key order already does not matter to canonicalize().
function stableModel(model: ModelBody): ModelBody {
  return {
    ...model,
    type_definitions: [...model.type_definitions].sort((a, b) => a.type.localeCompare(b.type)),
  };
}

function modelsEqual(a: ModelBody, b: ModelBody): boolean {
  return JSON.stringify(canonicalize(stableModel(a))) === JSON.stringify(canonicalize(stableModel(b)));
}

/** Create the store if needed and write fga/model.fga when it changed. Runs with `migrate`. */
export async function migrateFga(vars: Vars, modelSource: string | null): Promise<void> {
  const { client, storeId } = await fgaMigrateContext(vars);
  if (!modelSource) {
    console.log(`[openvoid] fga: store "${vars.OPENVOID_FGA_STORE ?? 'openvoid'}" ready (${storeId}), no fga/model.fga in this app`);
    return;
  }

  let desired: ModelBody;
  try {
    desired = transformer.transformDSLToJSONObject(modelSource) as WriteAuthorizationModelRequest;
  } catch (error) {
    throw new Error(`openvoid: fga/model.fga does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }

  let latestModel: AuthorizationModel | undefined;
  try {
    const res = await client.readLatestAuthorizationModel();
    latestModel = res.authorization_model;
  } catch (error) {
    // A brand new store has no authorization model yet; every other error is real.
    const status = (error as { status?: number; response?: { status?: number } }).status ?? (error as { response?: { status?: number } }).response?.status;
    if (status !== 404) throw error;
  }

  if (latestModel) {
    const { id: _id, ...latestBody } = latestModel;
    if (modelsEqual(latestBody, desired)) {
      console.log(`[openvoid] fga: model unchanged (store ${storeId}, model ${latestModel.id})`);
      return;
    }
  }

  const written = await client.writeAuthorizationModel(desired as WriteAuthorizationModelRequest);
  console.log(`[openvoid] fga: wrote model ${written.authorization_model_id} (store ${storeId})`);
}

export { modelsEqual, canonicalize };
