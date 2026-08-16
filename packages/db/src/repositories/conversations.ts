import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';

import { db, type DbExecutor } from '../client.js';
import { agentRuns, conversations, messages, type ConversationRow } from '../schema.js';
import type { AgentType, ConversationSummaryDTO, ConversationDetailDTO } from '@agentdesk/core';
import { toMessageDTO, type MessageWithRun } from './messages.js';

/**
 * Conversation reads and writes.
 *
 * Every function takes `userId` and filters on it. There is no "find by id"
 * that skips ownership — a caller cannot forget to scope, because the
 * unscoped variant does not exist.
 */

export async function createConversation(
  userId: string,
  title: string,
  tx: DbExecutor = db,
): Promise<{ id: string; title: string }> {
  const [row] = await tx
    .insert(conversations)
    .values({ userId, title })
    .returning({ id: conversations.id, title: conversations.title });

  if (!row) throw new Error('Conversation insert returned no row.');
  return row;
}

export async function touchConversation(id: string, tx: DbExecutor = db): Promise<void> {
  await tx.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));
}

/** Ownership check used before any write into a conversation. */
export async function findOwnedConversation(
  id: string,
  userId: string,
): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.id, id), eq(conversations.userId, userId), isNull(conversations.deletedAt)),
    )
    .limit(1);

  return row ?? null;
}

export interface ListConversationsResult {
  items: ConversationSummaryDTO[];
  nextCursor: string | null;
}

/**
 * Cursor pagination on `updatedAt`. Offset pagination would skip or repeat
 * rows as conversations get bumped by new messages, which in a chat list is
 * exactly the thing users notice.
 */
export async function listConversations(
  userId: string,
  options: { limit: number; cursor?: string | undefined },
): Promise<ListConversationsResult> {
  const cursorDate = options.cursor ? new Date(options.cursor) : null;
  const isValidCursor = cursorDate !== null && !Number.isNaN(cursorDate.getTime());

  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      // The outer column is written as a literal `conversations.id` rather than
      // interpolated with `${conversations.id}`. Drizzle renders an
      // interpolated column *unqualified* — plain `"id"` — and inside these
      // subqueries that binds to the messages row's own id instead of the
      // conversation's. The correlation then never matches and every count
      // comes back 0, with no error to notice. Qualifying explicitly is the fix.
      messageCount: sql<number>`(
        select count(*)::int from ${messages} m
        where m.conversation_id = conversations.id
      )`,
      lastMessagePreview: sql<string | null>`(
        select left(m.content, 140) from ${messages} m
        where m.conversation_id = conversations.id
        order by m.created_at desc limit 1
      )`,
      lastAgent: sql<AgentType | null>`(
        select m.agent from ${messages} m
        where m.conversation_id = conversations.id and m.agent is not null
        order by m.created_at desc limit 1
      )`,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
        isValidCursor ? lt(conversations.updatedAt, cursorDate) : undefined,
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    // One extra row tells us whether another page exists without a count query.
    .limit(options.limit + 1);

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    items: page.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      messageCount: row.messageCount,
      lastMessagePreview: row.lastMessagePreview,
      lastAgent: row.lastAgent,
    })),
    nextCursor: hasMore ? (page.at(-1)?.updatedAt.toISOString() ?? null) : null,
  };
}

export async function getConversationDetail(
  id: string,
  userId: string,
): Promise<ConversationDetailDTO | null> {
  const conversation = await findOwnedConversation(id, userId);
  if (!conversation) return null;

  const rows = await db
    .select({ message: messages, run: agentRuns })
    .from(messages)
    .leftJoin(agentRuns, eq(agentRuns.messageId, messages.id))
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  const items: MessageWithRun[] = rows.map((row) => ({ message: row.message, run: row.run }));

  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    summary: conversation.summary,
    messageCount: items.length,
    lastMessagePreview: items.at(-1)?.message.content.slice(0, 140) ?? null,
    lastAgent: [...items].reverse().find((i) => i.message.agent)?.message.agent ?? null,
    messages: items.map(toMessageDTO),
  };
}

/** Soft delete. Returns false when the conversation is not the caller's. */
export async function deleteConversation(id: string, userId: string): Promise<boolean> {
  const result = await db
    .update(conversations)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(conversations.id, id), eq(conversations.userId, userId), isNull(conversations.deletedAt)),
    )
    .returning({ id: conversations.id });

  return result.length > 0;
}

export async function saveConversationSummary(
  id: string,
  summary: string,
  summarizedUptoMessageId: string,
  tx: DbExecutor = db,
): Promise<void> {
  await tx
    .update(conversations)
    .set({ summary, summarizedUptoMessageId })
    .where(eq(conversations.id, id));
}
