import { runTurn } from '@agentdesk/agents';
import {
  NotFoundError,
  toAppError,
  type ChatStreamEvent,
  type ConversationDetailDTO,
  type ListConversationsQuery,
  type MessageDTO,
  type PaginatedDTO,
  type ConversationSummaryDTO,
  type SendMessageInput,
} from '@agentdesk/core';
import {
  createConversation,
  deleteConversation as deleteConversationRow,
  findOwnedConversation,
  getConversationDetail,
  insertAssistantTurn,
  insertUserMessage,
  listConversations as listConversationRows,
  touchConversation,
} from '@agentdesk/db';

import { logger } from '../lib/logger.js';

/**
 * Chat orchestration.
 *
 * Owns the sequence of a turn and the transaction boundaries. It knows nothing
 * about HTTP — no `Context`, no status codes, no headers — which is what lets
 * the integration tests drive it directly and lets the SSE controller stay a
 * thin adapter over `emit`.
 */

export async function listConversations(
  userId: string,
  query: ListConversationsQuery,
): Promise<PaginatedDTO<ConversationSummaryDTO>> {
  const result = await listConversationRows(userId, {
    limit: query.limit,
    cursor: query.cursor,
  });

  return { items: result.items, nextCursor: result.nextCursor };
}

export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationDetailDTO> {
  const conversation = await getConversationDetail(conversationId, userId);
  if (!conversation) throw new NotFoundError('Conversation');
  return conversation;
}

export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  const deleted = await deleteConversationRow(conversationId, userId);
  if (!deleted) throw new NotFoundError('Conversation');
}

/** Derive a readable title from the opening message. */
function titleFrom(content: string): string {
  const firstLine = content.trim().split('\n')[0] ?? content.trim();
  const trimmed = firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
  return trimmed || 'New conversation';
}

export interface SendMessageOptions {
  userId: string;
  input: SendMessageInput;
  emit: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

/**
 * Run one turn and stream it.
 *
 * Ordering here is deliberate. The user's message is persisted *before* the
 * agent runs, so a crash mid-turn leaves a conversation that still shows what
 * the customer asked rather than losing it. The `conversation` and
 * `user-message` events go out immediately after, so an optimistic UI can
 * reconcile its temporary ids before any model work begins.
 */
export async function sendMessage(options: SendMessageOptions): Promise<MessageDTO> {
  const { userId, input, emit } = options;

  emit({ type: 'status', phase: 'received' });

  let conversationId = input.conversationId;
  let summary: string | null = null;
  let summarizedUptoMessageId: string | null = null;

  if (conversationId) {
    const existing = await findOwnedConversation(conversationId, userId);
    if (!existing) throw new NotFoundError('Conversation');

    summary = existing.summary;
    summarizedUptoMessageId = existing.summarizedUptoMessageId;
  } else {
    const created = await createConversation(userId, titleFrom(input.content));
    conversationId = created.id;
    emit({ type: 'conversation', conversationId: created.id, title: created.title });
  }

  const userMessage = await insertUserMessage(conversationId, input.content);
  emit({ type: 'user-message', message: userMessage });

  // Bump the conversation now so it sorts to the top of the list even if the
  // agent turn fails — the customer's message is real either way.
  await touchConversation(conversationId);

  try {
    const turn = await runTurn({
      userId,
      conversationId,
      userMessage: input.content,
      existingSummary: summary,
      summarizedUptoMessageId,
      emit,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const assistantMessage = await insertAssistantTurn({
      conversationId,
      content: turn.text,
      agent: turn.agent,
      confidence: turn.confidence,
      reasoning: turn.reasoning,
      fellBack: turn.fellBack,
      toolCalls: turn.toolCalls,
      promptTokens: turn.promptTokens,
      completionTokens: turn.completionTokens,
      durationMs: turn.durationMs,
    });

    emit({
      type: 'done',
      message: assistantMessage,
      agent: turn.agent,
      usage: {
        promptTokens: turn.promptTokens,
        completionTokens: turn.completionTokens,
        toolCalls: turn.toolCalls.length,
        durationMs: turn.durationMs,
      },
    });

    return assistantMessage;
  } catch (error) {
    const appError = toAppError(error);

    logger.error(
      { conversationId, userId, code: appError.code, err: error },
      'Agent turn failed.',
    );

    // Deliberately not emitted here. Failures can also happen *before* this
    // try block — an unknown conversation id, for instance — and an emit in
    // each place would either double-report or, worse, miss the early ones.
    // The route emits exactly one terminal event for every failure path.
    throw appError;
  }
}
