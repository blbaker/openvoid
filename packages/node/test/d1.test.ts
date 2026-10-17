// The SQLite D1 binding, driven through drizzle-orm/d1 exactly the way void/db drives it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { SqliteD1Database } from '../src/bindings/d1-sqlite.ts';

const authors = sqliteTable('authors', { id: integer('id').primaryKey(), name: text('name').notNull() });
const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id').notNull().references(() => authors.id),
});

function setup() {
  const d1 = new SqliteD1Database({ path: ':memory:' });
  d1.prepare('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)').allSync();
  d1.prepare('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES authors(id))').allSync();
  return { d1, db: drizzle(d1.withSession('first-unconstrained') as never, { schema: { authors, posts } }) };
}

describe('D1 on SQLite', () => {
  it('inserts with returning and selects', async () => {
    const { db } = setup();
    const [doc] = await db.insert(authors).values({ name: 'Doc' }).returning();
    assert.deepEqual(doc, { id: 1, name: 'Doc' });
    await db.insert(posts).values({ title: 'Flux capacitor', authorId: 1 });
    assert.deepEqual(await db.select().from(posts).where(eq(posts.authorId, 1)), [{ id: 1, title: 'Flux capacitor', authorId: 1 }]);
  });

  it('keeps duplicate column names apart in joins (raw arrays)', async () => {
    const { db } = setup();
    await db.insert(authors).values({ id: 7, name: 'Marty' });
    await db.insert(posts).values({ id: 3, title: '1.21 GW', authorId: 7 });
    const rows = await db.select().from(posts).innerJoin(authors, eq(posts.authorId, authors.id));
    assert.deepEqual(rows, [{ posts: { id: 3, title: '1.21 GW', authorId: 7 }, authors: { id: 7, name: 'Marty' } }]);
  });

  it('runs relational queries with the schema', async () => {
    const { db } = setup();
    await db.insert(authors).values({ id: 1, name: 'Doc' });
    const found = await db.query.authors.findFirst({ where: eq(authors.name, 'Doc') });
    assert.equal(found?.id, 1);
  });

  it('batches atomically: one failure rolls back the whole batch', async () => {
    const { db } = setup();
    await assert.rejects(() =>
      db.batch([db.insert(authors).values({ id: 1, name: 'A' }), db.insert(posts).values({ id: 1, title: 'x', authorId: 999 })]),
    );
    assert.equal((await db.select({ n: sql<number>`count(*)` }).from(authors))[0]!.n, 0);
  });

  it('matches D1 binding semantics', async () => {
    const { d1 } = setup();
    await d1.prepare('INSERT INTO authors (id, name) VALUES (?, ?)').bind(1, 'Doc').run();
    assert.equal(await d1.prepare('SELECT name FROM authors WHERE id = ?').bind(1).first('name'), 'Doc');
    assert.equal(await d1.prepare('SELECT name FROM authors WHERE id = ?').bind(2).first(), null);
    assert.deepEqual(await d1.prepare('SELECT id, name FROM authors').raw({ columnNames: true }), [['id', 'name'], [1, 'Doc']]);
    const run = await d1.prepare('UPDATE authors SET name = ? WHERE id = ?').bind(true, 1).run();
    assert.equal(run.meta.changes, 1);
    assert.throws(() => d1.prepare('SELECT ?').bind(undefined), /undefined' not supported/);
    assert.equal(d1.withSession().getBookmark(), null);
  });
});
