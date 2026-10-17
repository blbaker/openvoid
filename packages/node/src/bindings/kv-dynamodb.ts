// KV binding on Amazon DynamoDB (or DynamoDB Local).
// Table: partition key "pk" (S) = namespace, sort key "sk" (S) = KV key. Sorting on sk gives
// list() the same key order as Cloudflare KV. Enable DynamoDB TTL on attribute "exp" so expired
// items are deleted for you; reads also hide them before TTL catches up.
import {
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  assertKey,
  clampLimit,
  cursor,
  decodeValue,
  expiryFrom,
  isExpired,
  toBytes,
  type KVGetOptions,
  type KVListKey,
  type KVListOptions,
  type KVListResult,
  type KVNamespaceLike,
  type KVPutOptions,
  type KVPutValue,
} from './kv-common.ts';

export type DynamoDBKVOptions = {
  table: string;
  /** Partition key value, so several namespaces can share one table. Default "default". */
  namespace?: string;
  /** Override for DynamoDB Local or another compatible endpoint. The SDK also reads AWS_ENDPOINT_URL_DYNAMODB. */
  endpoint?: string;
  region?: string;
  client?: DynamoDBClient;
};

type Item = Record<string, AttributeValue>;

export class DynamoDBKVNamespace implements KVNamespaceLike {
  readonly #table: string;
  readonly #ns: string;
  readonly #client: DynamoDBClient;

  constructor(options: DynamoDBKVOptions) {
    this.#table = options.table;
    this.#ns = options.namespace ?? 'default';
    this.#client =
      options.client ??
      new DynamoDBClient({
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.region ? { region: options.region } : {}),
      });
  }

  #key(key: string): Item {
    return { pk: { S: this.#ns }, sk: { S: key } };
  }

  async #item(key: string): Promise<Item | null> {
    assertKey(key);
    const out = await this.#client.send(
      new GetItemCommand({ TableName: this.#table, Key: this.#key(key), ConsistentRead: true }),
    );
    const item = out.Item;
    if (!item) return null;
    if (isExpired(item.exp?.N ? Number(item.exp.N) : null)) return null;
    return item;
  }

  async get(key: string, options?: KVGetOptions): Promise<unknown> {
    const item = await this.#item(key);
    return decodeValue(item?.v?.B ?? null, options);
  }

  async getWithMetadata(key: string, options?: KVGetOptions) {
    const item = await this.#item(key);
    return {
      value: decodeValue(item?.v?.B ?? null, options),
      metadata: item?.m?.S ? JSON.parse(item.m.S) : null,
      cacheStatus: null,
    };
  }

  async put(key: string, value: KVPutValue, options?: KVPutOptions): Promise<void> {
    assertKey(key);
    const item: Item = { ...this.#key(key), v: { B: await toBytes(value) } };
    const expiry = expiryFrom(options);
    if (expiry !== null) item.exp = { N: String(expiry) };
    if (options?.metadata !== undefined) item.m = { S: JSON.stringify(options.metadata) };
    await this.#client.send(new PutItemCommand({ TableName: this.#table, Item: item }));
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.#client.send(new DeleteItemCommand({ TableName: this.#table, Key: this.#key(key) }));
  }

  async list(options: KVListOptions = {}): Promise<KVListResult> {
    const limit = clampLimit(options.limit);
    const prefix = options.prefix ?? '';
    const after = cursor.decode(options.cursor);
    const now = Math.floor(Date.now() / 1000);
    const keys: KVListKey[] = [];
    let start: Item | undefined = after ? this.#key(after) : undefined;
    do {
      const out = await this.#client.send(
        new QueryCommand({
          TableName: this.#table,
          ConsistentRead: true,
          KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :prefix)' : 'pk = :pk',
          FilterExpression: 'attribute_not_exists(#exp) OR #exp > :now',
          ProjectionExpression: 'sk, #exp, m',
          ExpressionAttributeNames: { '#exp': 'exp' },
          ExpressionAttributeValues: {
            ':pk': { S: this.#ns },
            ':now': { N: String(now) },
            ...(prefix ? { ':prefix': { S: prefix } } : {}),
          },
          Limit: limit + 1 - keys.length,
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const item of out.Items ?? []) {
        keys.push({
          name: item.sk!.S!,
          ...(item.exp?.N ? { expiration: Number(item.exp.N) } : {}),
          ...(item.m?.S ? { metadata: JSON.parse(item.m.S) } : {}),
        });
      }
      start = out.LastEvaluatedKey;
    } while (start && keys.length <= limit);
    const page = keys.slice(0, limit);
    const complete = keys.length <= limit;
    return {
      keys: page,
      list_complete: complete,
      ...(complete ? {} : { cursor: cursor.encode(page[page.length - 1]!.name) }),
      cacheStatus: null,
    };
  }

  async close(): Promise<void> {
    this.#client.destroy();
  }
}
