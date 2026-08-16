import { asc, eq } from 'drizzle-orm';

import { db } from '../client.js';
import { users, type UserRow } from '../schema.js';

export interface User {
  id: string;
  name: string;
  email: string;
  tier: string;
}

function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, email: row.email, tier: row.tier };
}

export async function findUserById(id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ? toUser(row) : null;
}

/** Backs the demo user picker. Small table; no pagination needed. */
export async function listUsers(): Promise<User[]> {
  const rows = await db.select().from(users).orderBy(asc(users.name));
  return rows.map(toUser);
}
