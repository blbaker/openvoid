// One behaviour suite, run against every KV backend that is reachable.
// SQLite always runs. Redis and DynamoDB run when their test endpoints are set
// (scripts/services.sh up starts them and prints the variables).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KVNamespaceLike } from '../src/bindings/kv-common.ts';
import { SqliteKVNamespace } from '../src/bindings/kv-sqlite.ts';
import { RedisKVNamespace } from '../src/bindings/kv-redis.ts';
import { DynamoDBKVNamespace } from '../src/bindings/kv-dynamodb.ts';

type Factory = { name: string; skip?: string; make: () => Promise<KVNamespaceLike> };

const dynamoTable = `openvoid-test-${Date.now()}`;

const factories: Factory[] = [
  { name: 'sqlite', make: async () => new SqliteKVNamespace({ path: join(mkdtempSync(join(tmpdir(), 'ov-kv-')), 'kv.sqlite') }) },
  {
    name: 'redis',
    ...(process.env.OPENVOID_TEST_REDIS_URL ? {} : { skip: 'OPENVOID_TEST_REDIS_URL not set' }),
    make: async () => new RedisKVNamespace({ url: process.env.OPENVOID_TEST_REDIS_URL!, prefix: `t:${randomUUID()}:` }),
  },
  {
    name: 'dynamodb',
    ...(process.env.OPENVOID_TEST_DYNAMODB_ENDPOINT ? {} : { skip: 'OPENVOID_TEST_DYNAMODB_ENDPOINT not set' }),
    make: async () => {
      const { DynamoDBClient, CreateTableCommand, waitUntilTableExists } = await import('@aws-sdk/client-dynamodb');
      const client = new DynamoDBClient({ endpoint: process.env.OPENVOID_TEST_DYNAMODB_ENDPOINT, region: 'us-east-1' });
      await client
        .send(
          new CreateTableCommand({
            TableName: dynamoTable,
            BillingMode: 'PAY_PER_REQUEST',
            AttributeDefinitions: [
              { AttributeName: 'pk', AttributeType: 'S' },
              { AttributeName: 'sk', AttributeType: 'S' },
            ],
            KeySchema: [
              { AttributeName: 'pk', KeyType: 'HASH' },
              { AttributeName: 'sk', KeyType: 'RANGE' },
            ],
          }),
        )
        .catch((e: Error) => {
          if (e.name !== 'ResourceInUseException') throw e;
        });
      await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: dynamoTable });
      return new DynamoDBKVNamespace({ table: dynamoTable, namespace: randomUUID(), client });
    },
  },
];

for (const factory of factories) {
  describe(`KV backend: ${factory.name}`, { skip: factory.skip }, () => {
    let kv: KVNamespaceLike;
    before(async () => {
      kv = await factory.make();
    });
    after(async () => {
      await kv?.close?.();
    });

    it('returns null for a missing key', async () => {
      assert.equal(await kv.get('missing'), null);
      assert.deepEqual(await kv.getWithMetadata('missing'), { value: null, metadata: null, cacheStatus: null });
    });

    it('round-trips text, json and bytes', async () => {
      await kv.put('text', 'hello ames');
      assert.equal(await kv.get('text'), 'hello ames');
      await kv.put('json', JSON.stringify({ a: [1, 2] }));
      assert.deepEqual(await kv.get('json', 'json'), { a: [1, 2] });
      await kv.put('bytes', new Uint8Array([0, 255, 7]));
      assert.deepEqual([...new Uint8Array((await kv.get('bytes', { type: 'arrayBuffer' })) as ArrayBuffer)], [0, 255, 7]);
    });

    it('stores metadata and overwrites', async () => {
      await kv.put('meta', 'v1', { metadata: { owner: 'doc' } });
      assert.deepEqual(await kv.getWithMetadata('meta'), { value: 'v1', metadata: { owner: 'doc' }, cacheStatus: null });
      await kv.put('meta', 'v2');
      assert.deepEqual(await kv.getWithMetadata('meta'), { value: 'v2', metadata: null, cacheStatus: null });
    });

    it('deletes', async () => {
      await kv.put('gone', 'x');
      await kv.delete('gone');
      assert.equal(await kv.get('gone'), null);
      await kv.delete('never-existed');
    });

    it('hides expired keys from get and list', async () => {
      await kv.put('exp:past', 'old', { expiration: Math.floor(Date.now() / 1000) - 5 });
      await kv.put('exp:future', 'new', { expirationTtl: 3600 });
      assert.equal(await kv.get('exp:past'), null);
      const listed = await kv.list({ prefix: 'exp:' });
      assert.deepEqual(listed.keys.map((k) => k.name), ['exp:future']);
      assert.ok((listed.keys[0]!.expiration ?? 0) > Date.now() / 1000);
    });

    it('lists by prefix in key order and pages with a cursor', async () => {
      const names = ['p:b', 'p:a', 'p:c', 'p:%_', 'p:é', 'q:skip'];
      for (const name of names) await kv.put(name, name, { metadata: { n: name } });
      const first = await kv.list({ prefix: 'p:', limit: 2 });
      assert.equal(first.list_complete, false);
      assert.ok(first.cursor);
      const rest = await kv.list({ prefix: 'p:', cursor: first.cursor! });
      assert.equal(rest.list_complete, true);
      const all = [...first.keys, ...rest.keys].map((k) => k.name);
      assert.deepEqual(all, ['p:%_', 'p:a', 'p:b', 'p:c', 'p:é']);
      assert.deepEqual(first.keys[0]!.metadata, { n: 'p:%_' });
    });

    it('rejects invalid input like Cloudflare KV', async () => {
      await assert.rejects(() => kv.get(''), TypeError);
      await assert.rejects(() => kv.list({ limit: 0 }), RangeError);
    });
  });
}
