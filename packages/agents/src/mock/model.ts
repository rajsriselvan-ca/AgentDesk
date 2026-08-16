import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from '@ai-sdk/provider';
import type { AgentType, RoutingDecision } from '@agentdesk/core';

import { classifyIntent } from './classify.js';
import {
  extractInvoiceNumber,
  extractOrderReference,
  extractRefundReference,
  hasToolResults,
  lastUserText,
  observedToolResults,
} from './prompt-utils.js';
import { renderReply } from './reply.js';

/**
 * A deterministic language model.
 *
 * This is a real `LanguageModelV3`, so `streamText` and `generateObject` drive
 * it through exactly the same code path they use for Claude. The agents, the
 * tools, the streaming, the persistence, and the trace are all genuinely
 * exercised — the only thing replaced is the token generator.
 *
 * That matters for two reasons. A reviewer can clone the repo and watch the
 * whole system work with no API key. And the tests can assert on routing and
 * tool selection without depending on what a model felt like doing that run.
 */

export type ModelRole = AgentType | 'router' | 'compaction';

function usage(inputTokens: number, outputTokens: number): LanguageModelV3Usage {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  };
}

/** Rough token estimate; good enough for a trace and for budget arithmetic. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

interface PlannedToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

type Prompt = Parameters<typeof lastUserText>[0];

/**
 * Short replies often carry their meaning in the previous turn. Keep this
 * deliberately narrow so a genuinely vague new request does not inherit an
 * unrelated topic merely because it happens to be in the same conversation.
 */
const CONTEXTUAL_FOLLOW_UP =
  /\b(it|its|that|this|they|them|those|one|ones|there|held|still|next|other|same)\b|^(why|when|where|what about|and|also|can you|could you|do that)\b/i;

function messageText(message: Prompt[number]): string {
  if (typeof message.content === 'string') return message.content;

  if (!Array.isArray(message.content)) return '';

  return message.content
    .flatMap((part) =>
      part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part
        ? [String(part.text)]
        : [],
    )
    .join(' ');
}

/** The assistant answer plus customer message immediately before the latest turn. */
function previousTurnText(prompt: Prompt): string {
  const parts: string[] = [];
  let skippedLatestUser = false;

  for (let i = prompt.length - 1; i >= 0 && parts.length < 2; i -= 1) {
    const message = prompt[i];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;

    if (message.role === 'user' && !skippedLatestUser) {
      skippedLatestUser = true;
      continue;
    }

    const text = messageText(message);
    if (text) parts.push(text);
  }

  return parts.reverse().join(' ');
}

function mostRecentReference(
  prompt: Prompt,
  extract: (text: string) => string | null,
): string | null {
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const message = prompt[i];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const reference = extract(messageText(message));
    if (reference) return reference;
  }
  return null;
}

function contextualReason(intent: Exclude<AgentType, 'fallback'>, context: string): string {
  const reference =
    intent === 'order'
      ? extractOrderReference(context)
      : intent === 'billing'
        ? extractRefundReference(context) ??
          extractInvoiceNumber(context) ??
          extractOrderReference(context)
        : null;
  const topic = intent === 'order' ? 'order' : intent === 'billing' ? 'billing' : 'support';
  return `This follows the earlier ${topic} discussion${reference ? ` about ${reference}` : ''}.`;
}

/** Context-aware routing used by the deterministic model. */
export function classifyPromptIntent(prompt: Prompt): RoutingDecision {
  const text = lastUserText(prompt);
  const direct = classifyIntent(text);

  if (!CONTEXTUAL_FOLLOW_UP.test(text.trim()) || direct.confidence >= 0.78) return direct;

  const context = previousTurnText(prompt);
  if (!context) return direct;

  const inherited = classifyIntent(context);
  if (inherited.intent === 'fallback') return direct;

  return {
    intent: inherited.intent,
    confidence: Math.max(0.78, Math.min(0.92, inherited.confidence)),
    reasoning: contextualReason(inherited.intent, context),
  };
}

/**
 * Which tool this agent would reach for, given what the customer said.
 *
 * Deliberately explicit rather than clever: the point is that a reader can
 * predict the mock's behaviour from the source, and a test can assert it.
 */
export function planToolCall(
  agent: AgentType,
  text: string,
  prompt?: Prompt,
): PlannedToolCall | null {
  const lower = text.toLowerCase();
  const contextual = CONTEXTUAL_FOLLOW_UP.test(text.trim());
  const prior = contextual && prompt ? previousTurnText(prompt).toLowerCase() : '';

  if (agent === 'order') {
    const reference =
      extractOrderReference(text) ??
      (contextual && prompt ? mostRecentReference(prompt, extractOrderReference) : null);

    if (/\bcancel|call it off|don'?t want|stop the order\b/.test(lower)) {
      return reference
        ? {
            toolName: 'requestOrderChange',
            input: { orderReference: reference, action: 'cancel', reason: text.slice(0, 400) },
          }
        : { toolName: 'listOrders', input: { limit: 5 } };
    }

    if (
      /track|where is|delivery|deliver|parcel|package|courier|stuck|held|late|delayed|arriv/.test(
        lower,
      ) ||
      (contextual &&
        /track|where is|delivery|deliver|parcel|package|courier|stuck|exception|held|late|delayed|arriv/.test(
          prior,
        ))
    ) {
      return reference
        ? { toolName: 'checkDeliveryStatus', input: { orderReference: reference } }
        : { toolName: 'listOrders', input: { limit: 5 } };
    }

    return reference
      ? { toolName: 'getOrderDetails', input: { orderReference: reference } }
      : { toolName: 'listOrders', input: { limit: 5 } };
  }

  if (agent === 'billing') {
    const invoice =
      extractInvoiceNumber(text) ??
      (contextual && prompt ? mostRecentReference(prompt, extractInvoiceNumber) : null);
    const refund =
      extractRefundReference(text) ??
      (contextual && prompt ? mostRecentReference(prompt, extractRefundReference) : null);
    const order =
      extractOrderReference(text) ??
      (contextual && prompt ? mostRecentReference(prompt, extractOrderReference) : null);

    if (/refund|money back|reimburse/.test(lower) || (contextual && /refund|money back|reimburse/.test(prior))) {
      const reference = refund ?? order;
      return reference
        ? { toolName: 'checkRefundStatus', input: { reference } }
        : { toolName: 'checkRefundStatus', input: { reference: 'recent' } };
    }

    if (/declin|failed|payment|card|charge/.test(lower) || (contextual && /declin|failed|payment|card|charge/.test(prior))) {
      return { toolName: 'listPayments', input: { limit: 10 } };
    }

    if (/subscription|plan|renew|monthly|upgrade|downgrade/.test(lower) || (contextual && /subscription|plan|renew|monthly|upgrade|downgrade/.test(prior))) {
      return { toolName: 'getSubscription', input: {} };
    }

    return invoice
      ? { toolName: 'getInvoice', input: { invoiceNumber: invoice } }
      : { toolName: 'listInvoices', input: { limit: 5 } };
  }

  if (agent === 'support') {
    if (/last time|previously|earlier|before|already (told|said|contacted)|last week/.test(lower)) {
      return { toolName: 'searchConversationHistory', input: { query: keywords(text), limit: 5 } };
    }

    if (/crackl|rattl|broken|faulty|not working|won'?t|doesn'?t work|stuck|error|fault/.test(lower)) {
      return { toolName: 'getTroubleshootingSteps', input: { symptom: keywords(text), limit: 2 } };
    }

    return { toolName: 'getFaqArticle', input: { topic: keywords(text), limit: 3 } };
  }

  // fallback has no tools.
  return null;
}

/** Strip filler so the mock's search terms hit the seeded content. */
function keywords(text: string): string {
  const stop = new Set([
    'the', 'a', 'an', 'my', 'me', 'i', 'is', 'are', 'was', 'were', 'to', 'of', 'for', 'on', 'in',
    'it', 'this', 'that', 'and', 'or', 'but', 'can', 'you', 'please', 'help', 'with', 'about',
    'what', 'how', 'when', 'why', 'do', 'does', 'did', 'have', 'has', 'get', 'got', 'be',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stop.has(word));

  return words.slice(0, 4).join(' ') || text.slice(0, 60);
}

const MOCK_STREAM_DELAY_MS = 24;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function textStream(parts: string[], inputTokens: number): ReadableStream<LanguageModelV3StreamPart> {
  const outputTokens = parts.reduce((sum, part) => sum + estimateTokens(part), 0);
  const animate = process.env.NODE_ENV !== 'test' && parts.length > 1;
  let cancelled = false;

  return new ReadableStream<LanguageModelV3StreamPart>({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: 'text-0' });
      for (const part of parts) {
        // The local provider should demonstrate the same gradual UI behaviour
        // as a network model. Tests stay synchronous and fast.
        if (animate) await pause(MOCK_STREAM_DELAY_MS);
        if (cancelled) return;
        controller.enqueue({ type: 'text-delta', id: 'text-0', delta: part });
      }
      if (cancelled) return;
      controller.enqueue({ type: 'text-end', id: 'text-0' });
      controller.enqueue({
        type: 'finish',
        finishReason: { unified: 'stop', raw: undefined },
        usage: usage(inputTokens, outputTokens),
      });
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
}

function toolCallStream(
  call: PlannedToolCall,
  inputTokens: number,
): ReadableStream<LanguageModelV3StreamPart> {
  const input = JSON.stringify(call.input);
  const toolCallId = `mock_${Math.random().toString(36).slice(2, 10)}`;

  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'tool-input-start', id: toolCallId, toolName: call.toolName });
      controller.enqueue({ type: 'tool-input-delta', id: toolCallId, delta: input });
      controller.enqueue({ type: 'tool-input-end', id: toolCallId });
      controller.enqueue({
        type: 'tool-call',
        toolCallId,
        toolName: call.toolName,
        input,
      });
      controller.enqueue({
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: usage(inputTokens, estimateTokens(input)),
      });
      controller.close();
    },
  });
}

/** Split a reply into delta-sized chunks so the UI streams rather than blinks. */
function chunk(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

export function createMockModel(role: ModelRole): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'agentdesk-mock',
    modelId: `mock-${role}`,

    doGenerate: async (options) => {
      const text = lastUserText(options.prompt);
      const inputTokens = estimateTokens(JSON.stringify(options.prompt));

      if (role === 'router') {
        const decision = classifyPromptIntent(options.prompt);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(decision) }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(inputTokens, 40),
          warnings: [],
        };
      }

      if (role === 'compaction') {
        return {
          content: [{ type: 'text' as const, text: summarisePrompt(options.prompt) }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(inputTokens, 60),
          warnings: [],
        };
      }

      const reply = renderReply(role, text, observedToolResults(options.prompt));
      return {
        content: [{ type: 'text' as const, text: reply }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: usage(inputTokens, estimateTokens(reply)),
        warnings: [],
      };
    },

    doStream: async (options) => {
      const text = lastUserText(options.prompt);
      const inputTokens = estimateTokens(JSON.stringify(options.prompt));

      if (role === 'router' || role === 'compaction') {
        const body =
          role === 'router'
            ? JSON.stringify(classifyPromptIntent(options.prompt))
            : summarisePrompt(options.prompt);
        return { stream: textStream([body], inputTokens) };
      }

      // First pass with tools available: call one. Second pass (results are
      // already in the prompt): write the answer.
      if (!hasToolResults(options.prompt)) {
        const planned = planToolCall(role, text, options.prompt);
        const toolsAvailable = (options.tools?.length ?? 0) > 0;

        if (planned && toolsAvailable) {
          return { stream: toolCallStream(planned, inputTokens) };
        }
      }

      const reply = renderReply(role, text, observedToolResults(options.prompt));
      return { stream: textStream(chunk(reply), inputTokens) };
    },
  });
}

function summarisePrompt(prompt: Parameters<typeof lastUserText>[0]): string {
  const turns = prompt.filter((message) => message.role === 'user' || message.role === 'assistant');
  const topics = new Set<string>();

  for (const message of turns) {
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join(' ');

    for (const reference of content.match(/\b(AD|INV|RF)-\d{3,6}\b/gi) ?? []) {
      topics.add(reference.toUpperCase());
    }
  }

  const references = topics.size > 0 ? ` References discussed: ${[...topics].join(', ')}.` : '';
  return `Earlier in this conversation the customer raised ${turns.length} messages covering their orders, billing, and support questions.${references}`;
}
