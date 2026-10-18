// OpenFGA-backed behaviour. Skipped unless OPENVOID_TEST_FGA_URL is set. Follows the pattern of
// test/kv.conformance.test.ts: the backend is started out of band and its address handed in.
//
//   docker run -d --name openvoid-fga-test -p 127.0.0.1:46280:8080 openfga/openfga run
//   cd packages/node && OPENVOID_TEST_FGA_URL=http://127.0.0.1:46280 node --no-warnings --test 'test/**/*.test.ts'
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenFgaClient } from '@openfga/sdk';
import { migrateFga, onSignIn, check, requirePermission, listObjects, grant, revoke, writeTuples, fgaUser, resetFgaContextCache } from '../src/fga/index.ts';
import { encodeFgaId, decodeFgaId } from '../src/fga/ids.ts';
import { runWithSession, AuthHttpError } from '../src/auth/context.ts';
import type { AuthUser } from '../src/auth/types.ts';

const FGA_URL = process.env.OPENVOID_TEST_FGA_URL;

const MODEL = `model
  schema 1.1

type user

type group
  relations
    define member: [user]

type doc
  relations
    define owner: [user]
    define editor: [user] or owner
    define viewer: [user, group#member] or editor
`;

function makeUser(id: string, groups: string[] = []): AuthUser {
  const [provider, subject] = id.split(':') as [string, string];
  return { id, provider, subject, email: null, emailVerified: true, name: null, image: null, groups };
}

const alice = makeUser('test:alice');
const bob = makeUser('test:bob');

function runAs<T>(user: AuthUser, fn: () => Promise<T>): Promise<T> {
  return runWithSession({ id: '', user, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }, '/auth', fn);
}

describe('fga id encoding', () => {
  it('round-trips arbitrary strings, including characters OpenFGA reserves', () => {
    const cases = ['alice', 'authelia:7f3a-b2', 'weird#id*with:reserved chars', 'spaces and/slashes', '_looks_like_an_escape_5f', 'ünïcödé'];
    for (const raw of cases) {
      const encoded = encodeFgaId(raw);
      assert.ok(!/[:#*\s]/.test(encoded), `encoded id must avoid OpenFGA's reserved/whitespace characters: ${encoded}`);
      assert.equal(decodeFgaId(encoded), raw);
    }
  });

  it('rejects an empty id and an invalid escape', () => {
    assert.throws(() => encodeFgaId(''));
    assert.throws(() => decodeFgaId('abc_zz'));
    assert.throws(() => decodeFgaId('abc_1'));
  });

  it('fgaUser() prefixes with user: and encodes AuthUser.id or a raw id string', () => {
    assert.equal(fgaUser('proxy:doc'), `user:${encodeFgaId('proxy:doc')}`);
    assert.equal(fgaUser(alice), `user:${encodeFgaId(alice.id)}`);
  });
});

describe('OpenFGA', { skip: FGA_URL ? undefined : 'OPENVOID_TEST_FGA_URL not set' }, () => {
  const store = `openvoid-test-${process.pid}-${Date.now()}`;
  const vars = { OPENVOID_FGA_URL: FGA_URL, OPENVOID_FGA_STORE: store };

  before(() => {
    process.env.OPENVOID_FGA_URL = FGA_URL;
    process.env.OPENVOID_FGA_STORE = store;
    delete process.env.OPENVOID_FGA_STORE_ID;
    delete process.env.OPENVOID_FGA_SYNC_GROUPS;
  });

  after(() => {
    resetFgaContextCache();
  });

  it('migrate creates the store and model, is idempotent, and a changed model writes a new version', async () => {
    await migrateFga(vars, MODEL);
    const probe = new OpenFgaClient({ apiUrl: FGA_URL! });
    const { stores } = await probe.listStores({ name: store });
    assert.equal(stores.length, 1);
    probe.storeId = stores[0]!.id;

    const first = await probe.readAuthorizationModels();
    assert.equal(first.authorization_models.length, 1);

    await migrateFga(vars, MODEL);
    const second = await probe.readAuthorizationModels();
    assert.equal(second.authorization_models.length, 1, 'an identical fga/model.fga must not write a new version');

    const changed = MODEL.replace('define owner: [user]', 'define owner: [user, group#member]');
    await migrateFga(vars, changed);
    const third = await probe.readAuthorizationModels();
    assert.equal(third.authorization_models.length, 2, 'a changed fga/model.fga must write a new version');

    await migrateFga(vars, changed);
    const fourth = await probe.readAuthorizationModels();
    assert.equal(fourth.authorization_models.length, 2, 're-running an unchanged (already updated) model must not write again');
  });

  it('migrate without fga/model.fga only ensures the store exists', async () => {
    const bareStore = `${store}-bare`;
    await migrateFga({ OPENVOID_FGA_URL: FGA_URL, OPENVOID_FGA_STORE: bareStore }, null);
    const probe = new OpenFgaClient({ apiUrl: FGA_URL! });
    const { stores } = await probe.listStores({ name: bareStore });
    assert.equal(stores.length, 1);
  });

  it('check, listObjects, grant and revoke', async () => {
    await runAs(alice, async () => {
      await grant('owner', 'doc:checks-1');
      assert.equal(await check('owner', 'doc:checks-1'), true);
      assert.equal(await check('editor', 'doc:checks-1'), true, 'owner implies editor');
      assert.equal(await check('viewer', 'doc:checks-1'), true, 'editor implies viewer');
    });
    assert.equal(await check('viewer', 'doc:checks-1', { user: bob }), false, 'bob has no relation to the doc');
    assert.equal(await check('viewer', 'doc:checks-1'), false, 'anonymous is always false');
    assert.deepEqual(await listObjects('doc', 'owner', { user: alice }), ['doc:checks-1']);
    assert.deepEqual(await listObjects('doc', 'owner', { user: bob }), []);
    assert.deepEqual(await listObjects('doc', 'owner'), [], 'anonymous listObjects is always empty');

    await runAs(alice, async () => {
      await revoke('owner', 'doc:checks-1');
      assert.equal(await check('owner', 'doc:checks-1'), false);
      assert.equal(await check('viewer', 'doc:checks-1'), false);
    });
  });

  it('requirePermission: 401 anonymous, 403 denied, passes when allowed', async () => {
    await grant('owner', 'doc:perm-1', { user: alice });

    await assert.rejects(
      () => requirePermission('viewer', 'doc:perm-1'),
      (error: unknown) => {
        assert.ok(error instanceof AuthHttpError);
        assert.equal(error.status, 401);
        return true;
      },
    );

    await runAs(bob, () =>
      assert.rejects(
        () => requirePermission('viewer', 'doc:perm-1'),
        (error: unknown) => {
          assert.ok(error instanceof AuthHttpError);
          assert.equal(error.status, 403);
          return true;
        },
      ),
    );

    await runAs(alice, () => assert.doesNotReject(() => requirePermission('viewer', 'doc:perm-1')));
  });

  it('group sync adds and removes memberships; a group-based grant works', async () => {
    process.env.OPENVOID_FGA_SYNC_GROUPS = '1';
    try {
      const carol = makeUser('test:carol', ['family']);
      await onSignIn(carol, process.env);
      assert.equal(await check('viewer', 'doc:family-doc', { user: carol }), false, 'not shared with the group yet');

      await grant('owner', 'doc:family-doc', { user: alice });
      await writeTuples([{ user: 'group:family#member', relation: 'viewer', object: 'doc:family-doc' }]);
      assert.equal(await check('viewer', 'doc:family-doc', { user: carol }), true, 'group membership grants the shared viewer relation');
      assert.equal(await check('editor', 'doc:family-doc', { user: carol }), false, 'sharing with a group does not grant editor');

      await onSignIn(carol, process.env); // identical groups: idempotent, no error
      assert.equal(await check('viewer', 'doc:family-doc', { user: carol }), true);

      await onSignIn({ ...carol, groups: [] }, process.env);
      assert.equal(await check('viewer', 'doc:family-doc', { user: carol }), false, 'leaving the group loses the shared access');
    } finally {
      delete process.env.OPENVOID_FGA_SYNC_GROUPS;
    }
  });
});
