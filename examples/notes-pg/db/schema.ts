import { pgTable, serial, text, timestamp } from 'void/schema-pg';

export const notes = pgTable('notes', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
