import { and, asc, desc, eq, gt, ilike, or, sql } from 'drizzle-orm';

import { db, type DbExecutor } from '../client.js';
import { agentRuns, conversations, messages, type AgentRunRow, type MessageRow } from '../schema.js';
import type { AgentTraceDTO, AgentType, MessageDTO } from '@agentdesk/core';

export interface MessageWithRun {
  message: MessageRow;
  run: AgentRunRow | null;
}

export function toMessageDTO({ message, run }: MessageWithRun): MessageDTO {
  const trace: AgentTraceDTO | null = run
    ? {
        agent: run.agent,
        confidence: run.confidence,
        reasoning: run.reasoning,
        fellBack: run.fellBack,
        toolCalls: run.toolCalls,
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        durationMs: run.durationMs,
      }
    : null;

  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    agent: message.agent,
    createdAt: message.createdAt.toISOString(),
    trace,
  };
}

export async function insertUserMessage(
  conversationId: string,
  content: string,
  tx: DbExecutor = db,
): Promise<MessageDTO> {
  const [row] = await tx
    .insert(messages)
    .values({ conversationId, role: 'user', content })
    .returning();

  if (!row) throw new Error('Message insert returned no row.');
  return toMessageDTO({ message: row, run: null });
}

export interface AssistantTurn {
  conversationId: string;
  content: string;
  agent: AgentType;
  confidence: number;
  reasoning: string;
  fellBack: boolean;
  toolCalls: AgentTraceDTO['toolCalls'];
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

/**
 * Persist the assistant message and its trace atomically.
 *
 * These belong in one transaction: a message without its trace would render
 * in the UI with an empty reasoning panel and no way to tell whether the
 * agent skipped its tools or the write simply failed.
 */
export async function insertAssistantTurn(turn: AssistantTurn): Promise<MessageDTO> {
  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(messages)
      .values({
        conversationId: turn.conversationId,
        role: 'assistant',
        content: turn.content,
        agent: turn.agent,
      })
      .returning();

    if (!message) throw new Error('Assistant message insert returned no row.');

    const [run] = await tx
      .insert(agentRuns)
      .values({
        messageId: message.id,
        conversationId: turn.conversationId,
        agent: turn.agent,
        confidence: turn.confidence,
        reasoning: turn.reasoning,
        fellBack: turn.fellBack,
        toolCalls: turn.toolCalls,
        promptTokens: turn.promptTokens,
        completionTokens: turn.completionTokens,
        durationMs: turn.durationMs,
      })
      .returning();

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, turn.conversationId));

    return toMessageDTO({ message, run: run ?? null });
  });
}

/**
 * The tail of a conversation, oldest first.
 *
 * `afterMessageId` skips everything already folded into the rolling summary,
 * so compacted history is never sent twice.
 */
export async function getRecentMessages(
  conversationId: string,
  limit: number,
  afterMessageId?: string | null,
): Promise<Array<{ role: 'user' | 'assistant'; content: string; agent: AgentType | null }>> {
  const after = afterMessageId
    ? sql`${messages.createdAt} > (select created_at from ${messages} where id = ${afterMessageId})`
    : undefined;

  const rows = await db
    .select({ role: messages.role, content: messages.content, agent: messages.agent })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), after))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows.reverse();
}

/** Everything up to and including a message — the input to a compaction pass. */
export async function getMessagesForCompaction(
  conversationId: string,
  keepRecent: number,
): Promise<Array<{ id: string; role: 'user' | 'assistant'; content: string }>> {
  const all = await db
    .select({ id: messages.id, role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  return all.slice(0, Math.max(0, all.length - keepRecent));
}

export async function countMessages(conversationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));

  return row?.count ?? 0;
}

export interface HistoryMatch {
  conversationId: string;
  conversationTitle: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

/**
 * Full-text-ish search across the caller's own past conversations.
 *
 * Backs the support agent's history tool. `ilike` is honest for a dataset this
 * size; a production desk would put this behind tsvector or a vector index,
 * and the tool's contract would not change.
 */
export async function searchUserMessages(
  userId: string,
  query: string,
  limit: number,
  excludeConversationId?: string,
): Promise<HistoryMatch[]> {
  const term = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;

  const rows = await db
    .select({
      conversationId: messages.conversationId,
      conversationTitle: conversations.title,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.userId, userId),
        sql`${conversations.deletedAt} is null`,
        excludeConversationId
          ? sql`${messages.conversationId} <> ${excludeConversationId}`
          : undefined,
        or(ilike(messages.content, term), ilike(conversations.title, term)),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    conversationId: row.conversationId,
    conversationTitle: row.conversationTitle,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  }));
}
