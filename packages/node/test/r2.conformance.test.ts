// One behaviour suite for every R2-compatible storage backend that is reachable.
// The filesystem backend always runs; S3 runs when OPENVOID_TEST_S3_ENDPOINT is set (MinIO locally).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileR2Bucket } from '../src/bindings/r2-fs.ts';
import { S3R2Bucket } from '../src/bindings/r2-s3.ts';

type Bucket = FileR2Bucket | S3R2Bucket;
type Factory = { name: string; skip?: string; make: () => Promise<Bucket> };

let fsRoot = '';

const factories: Factory[] = [
  {
    name: 'filesystem',
    make: async () => {
      fsRoot = mkdtempSync(join(tmpdir(), 'ov-r2-'));
      return new FileR2Bucket({ root: join(fsRoot, 'bucket') });
    },
  },
  {
    name: 's3',
    ...(process.env.OPENVOID_TEST_S3_ENDPOINT ? {} : { skip: 'OPENVOID_TEST_S3_ENDPOINT not set' }),
    make: async () => {
      const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({ endpoint: process.env.OPENVOID_TEST_S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true });
      const bucket = 'openvoid-test';
      await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((e: Error) => {
        if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(e.name)) throw e;
      });
      return new S3R2Bucket({ bucket, prefix: `${randomUUID()}/`, client });
    },
  },
];

for (const factory of factories) {
  describe(`storage backend: ${factory.name}`, { skip: factory.skip }, () => {
    let bucket: Bucket;
    before(async () => {
      bucket = await factory.make();
    });
    after(async () => {
      await bucket?.close();
    });

    it('returns null for missing objects', async () => {
      assert.equal(await bucket.get('nope'), null);
      assert.equal(await bucket.head('nope'), null);
    });

    it('round-trips bytes with http and custom metadata', async () => {
      const put = await bucket.put('docs/readme.txt', 'great scott', {
        httpMetadata: { contentType: 'text/plain', cacheControl: 'max-age=60' },
        customMetadata: { owner: 'doc' },
      });
      assert.equal(put.size, 11);
      const got = await bucket.get('docs/readme.txt');
      assert.ok(got);
      assert.equal(await got.text(), 'great scott');
      assert.equal(got.httpMetadata.contentType, 'text/plain');
      assert.equal(got.customMetadata.owner, 'doc');
      assert.equal(got.etag, put.etag);
      const headers = new Headers();
      got.writeHttpMetadata(headers);
      assert.equal(headers.get('cache-control'), 'max-age=60');
      const head = await bucket.head('docs/readme.txt');
      assert.equal(head?.size, 11);
    });

    it('reads byte ranges', async () => {
      await bucket.put('range.bin', '0123456789');
      assert.equal(await (await bucket.get('range.bin', { range: { offset: 2, length: 3 } }))!.text(), '234');
      assert.equal(await (await bucket.get('range.bin', { range: { suffix: 2 } }))!.text(), '89');
      const ranged = await bucket.get('range.bin', { range: new Headers({ range: 'bytes=5-' }) });
      assert.equal(await ranged!.text(), '56789');
      assert.equal(ranged!.size, 10);
    });

    it('treats awkward keys as plain keys', async () => {
      const key = 'spaces & ü/?#%+.txt';
      await bucket.put(key, 'safe');
      assert.equal(await (await bucket.get(key))!.text(), 'safe');
      assert.deepEqual((await bucket.list({ prefix: 'spaces' })).objects.map((o) => o.key), [key]);
    });

    if (factory.name === 'filesystem') {
      it('never writes outside its root for "../" keys', async () => {
        await bucket.put('../../escape.txt', 'contained');
        assert.equal(await (await bucket.get('../../escape.txt'))!.text(), 'contained');
        assert.deepEqual(readdirSync(fsRoot), ['bucket']);
        assert.equal(existsSync(join(fsRoot, '..', 'escape.txt')), false);
      });
    }

    it('lists with prefix, delimiter and cursor', async () => {
      for (const key of ['l/a.txt', 'l/b.txt', 'l/sub/c.txt', 'l/sub/d.txt', 'l/z.txt']) await bucket.put(key, key);
      const flat = await bucket.list({ prefix: 'l/' });
      assert.deepEqual(flat.objects.map((o) => o.key), ['l/a.txt', 'l/b.txt', 'l/sub/c.txt', 'l/sub/d.txt', 'l/z.txt']);
      const grouped = await bucket.list({ prefix: 'l/', delimiter: '/' });
      assert.deepEqual(grouped.objects.map((o) => o.key), ['l/a.txt', 'l/b.txt', 'l/z.txt']);
      assert.deepEqual(grouped.delimitedPrefixes, ['l/sub/']);
      const page1 = await bucket.list({ prefix: 'l/', limit: 2 });
      assert.equal(page1.truncated, true);
      const page2 = await bucket.list({ prefix: 'l/', limit: 10, cursor: page1.cursor! });
      assert.deepEqual([...page1.objects, ...page2.objects].map((o) => o.key).length, 5);
    });

    it('deletes one or many', async () => {
      await bucket.put('d/1', '1');
      await bucket.put('d/2', '2');
      await bucket.delete(['d/1', 'd/2']);
      assert.equal((await bucket.list({ prefix: 'd/' })).objects.length, 0);
      await bucket.delete('d/never');
    });

    it('rejects conditional requests instead of ignoring them', async () => {
      await assert.rejects(() => bucket.get('x', { onlyIf: { etagMatches: 'abc' } }), /onlyIf is not supported/);
    });
  });
}
