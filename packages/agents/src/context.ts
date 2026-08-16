import { generateText, type ModelMessage } from 'ai';
import { getEnv } from '@agentdesk/core/env';
import { getMessagesForCompaction, getRecentMessages, saveConversationSummary } from '@agentdesk/db';

import { estimateTokens } from './mock/model.js';
import { resolveModel } from './provider.js';

/**
 * Conversation context assembly and compaction.
 *
 * Both the router and the chosen specialist receive the *same* context, so the
 * router classifies against exactly the history the specialist will answer
 * from. A router that sees less than the agent will mis-route follow-ups like
 * "what about the other one?".
 *
 * Compaction runs when the assembled context exceeds its token budget: the
 * oldest messages are folded into a rolling summary, stored on the
 * conversation, and replayed as a single system message from then on. The cost
 * is paid once rather than on every subsequent turn.
 */

export interface ConversationContext {
  messages: ModelMessage[];
  /** The rolling summary in play, if any. */
  summary: string | null;
  estimatedTokens: number;
  compacted: boolean;
}

export interface BuildContextInput {
  conversationId: string;
  /** The message just received, already persisted. */
  latestUserMessage: string;
  existingSummary: string | null;
  summarizedUptoMessageId: string | null;
  onCompactionStart?: () => void;
}

export async function buildConversationContext(
  input: BuildContextInput,
): Promise<ConversationContext> {
  const env = getEnv();

  const history = await getRecentMessages(
    input.conversationId,
    env.CONTEXT_RECENT_MESSAGES,
    input.summarizedUptoMessageId,
  );

  let summary = input.existingSummary;
  let compacted = false;

  const assemble = (): ModelMessage[] => {
    const messages: ModelMessage[] = [];

    if (summary) {
      messages.push({
        role: 'system',
        content: `Summary of the earlier part of this conversation:\n${summary}`,
      });
    }

    for (const message of history) {
      messages.push({ role: message.role, content: message.content });
    }

    // The caller normally persists the incoming message before getting here, so
    // it arrives as the tail of `history`. Appending it when it is missing means
    // the runtime does not silently depend on that write ordering — getting it
    // wrong would otherwise surface as "messages must not be empty" from deep
    // inside the SDK, which says nothing about the actual mistake.
    const tail = messages.at(-1);
    if (tail?.role !== 'user' || tail.content !== input.latestUserMessage) {
      messages.push({ role: 'user', content: input.latestUserMessage });
    }

    return messages;
  };

  let messages = assemble();
  let estimated = estimateContextTokens(messages);

  if (estimated > env.CONTEXT_TOKEN_BUDGET) {
    input.onCompactionStart?.();

    const compactedSummary = await compactConversation({
      conversationId: input.conversationId,
      keepRecent: env.CONTEXT_RECENT_MESSAGES,
      existingSummary: summary,
    });

    if (compactedSummary) {
      summary = compactedSummary;
      compacted = true;
      messages = assemble();
      estimated = estimateContextTokens(messages);
    }
  }

  return { messages, summary, estimatedTokens: estimated, compacted };
}

export function estimateContextTokens(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => {
    const content =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    return total + estimateTokens(content) + 4;
  }, 0);
}

interface CompactInput {
  conversationId: string;
  keepRecent: number;
  existingSummary: string | null;
}

/**
 * Fold everything except the most recent messages into a summary.
 *
 * Uses the cheap model deliberately — condensing a transcript does not need
 * the same capability as resolving a billing dispute, and this runs on the
 * critical path of a user-visible turn.
 */
async function compactConversation(input: CompactInput): Promise<string | null> {
  const older = await getMessagesForCompaction(input.conversationId, input.keepRecent);
  if (older.length === 0) return null;

  const lastCompacted = older.at(-1);
  if (!lastCompacted) return null;

  const transcript = older
    .map((message) => `${message.role === 'user' ? 'Customer' : 'Agent'}: ${message.content}`)
    .join('\n');

  const previous = input.existingSummary
    ? `Here is the summary so far, which you should fold into the new one:\n${input.existingSummary}\n\n`
    : '';

  try {
    const model = await resolveModel('compaction');

    const { text } = await generateText({
      model,
      system:
        'You compress support conversations so an agent can pick them up cold. Keep every concrete detail that could matter later: order and invoice references, amounts, dates, what was promised, and what is still outstanding. Drop pleasantries and restatement. Write it as plain prose under 200 words, in the third person.',
      prompt: `${previous}Summarise this part of the conversation:\n\n${transcript}`,
    });

    const summary = text.trim();
    if (!summary) return null;

    await saveConversationSummary(input.conversationId, summary, lastCompacted.id);
    return summary;
  } catch {
    // Compaction is an optimisation. If it fails, the turn continues on the
    // recent-messages window alone rather than failing the customer's request.
    return null;
  }
}
