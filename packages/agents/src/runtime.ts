import { stepCountIs, streamText } from 'ai';
import { getEnv } from '@agentdesk/core/env';
import { AgentError, type AgentType, type ChatStreamEvent, type ToolCallDTO } from '@agentdesk/core';

import { buildConversationContext } from './context.js';
import { resolveModel } from './provider.js';
import { AGENT_DEFINITIONS, buildToolSet } from './registry.js';
import { routeMessage } from './router.js';
import type { ToolContext } from './tools/define.js';

/**
 * One conversational turn, end to end.
 *
 * Assemble context, route, delegate, stream, and report. Events are pushed to
 * `emit` as they happen rather than collected and returned at the end, because
 * the whole point of the SSE contract is that the customer sees the desk
 * working — the routing decision lands before the specialist has written a
 * word, and each tool call appears as it runs.
 *
 * Persistence deliberately lives outside this function. The runtime produces
 * the turn; the chat service decides how to store it.
 */

export interface RunTurnInput {
  userId: string;
  conversationId: string;
  userMessage: string;
  existingSummary: string | null;
  summarizedUptoMessageId: string | null;
  emit: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

export interface TurnResult {
  agent: AgentType;
  text: string;
  confidence: number;
  reasoning: string;
  fellBack: boolean;
  toolCalls: ToolCallDTO[];
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const env = getEnv();
  const startedAt = performance.now();

  input.emit({ type: 'status', phase: 'routing' });

  const context = await buildConversationContext({
    conversationId: input.conversationId,
    latestUserMessage: input.userMessage,
    existingSummary: input.existingSummary,
    summarizedUptoMessageId: input.summarizedUptoMessageId,
    onCompactionStart: () => {
      input.emit({
        type: 'status',
        phase: 'compacting',
        detail: 'Condensing earlier messages to stay within context',
      });
    },
  });

  const routing = await routeMessage(context);

  input.emit({
    type: 'routed',
    agent: routing.intent,
    confidence: routing.confidence,
    reasoning: routing.reasoning,
    fellBack: routing.fellBack,
  });

  const definition = AGENT_DEFINITIONS[routing.intent];
  input.emit({ type: 'status', phase: 'thinking', detail: definition.name });

  const toolCalls: ToolCallDTO[] = [];

  const toolContext: ToolContext = {
    userId: input.userId,
    conversationId: input.conversationId,
    timeoutMs: env.TOOL_TIMEOUT_MS,
    onToolCall: (call) => {
      toolCalls.push(call);
      input.emit({
        type: 'tool-result',
        callId: call.callId,
        tool: call.tool,
        ok: call.ok,
        summary: call.summary,
        durationMs: call.durationMs,
      });
    },
  };

  const tools = buildToolSet(routing.intent, toolContext);
  const model = await resolveModel(routing.intent);

  let text = '';
  let promptTokens = routing.promptTokens;
  let completionTokens = routing.completionTokens;
  let sawText = false;

  try {
    const result = streamText({
      model,
      system: definition.systemPrompt,
      messages: context.messages,
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
      stopWhen: stepCountIs(env.AGENT_MAX_STEPS),
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'tool-call':
          input.emit({
            type: 'tool-call',
            callId: part.toolCallId,
            tool: part.toolName,
            args: (part.input ?? {}) as Record<string, unknown>,
          });
          input.emit({ type: 'status', phase: 'calling_tool', detail: part.toolName });
          break;

        case 'text-delta': {
          if (!sawText) {
            sawText = true;
            input.emit({ type: 'status', phase: 'writing' });
          }
          const delta = part.text;
          if (delta) {
            text += delta;
            input.emit({ type: 'text-delta', text: delta });
          }
          break;
        }

        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error));

        default:
          break;
      }
    }

    const usage = await result.usage;
    promptTokens += usage?.inputTokens ?? 0;
    completionTokens += usage?.outputTokens ?? 0;
  } catch (error) {
    if (input.signal?.aborted) {
      // The customer navigated away or hit stop. Keep whatever was written so
      // the partial answer can still be persisted and shown.
      text = text.trim();
    } else {
      throw new AgentError(
        `The ${definition.name.toLowerCase()} agent could not complete this turn.`,
        error,
      );
    }
  }

  const finalText = text.trim();

  if (!finalText) {
    throw new AgentError('The agent produced an empty response.');
  }

  return {
    agent: routing.intent,
    text: finalText,
    confidence: routing.confidence,
    reasoning: routing.reasoning,
    fellBack: routing.fellBack,
    toolCalls,
    promptTokens,
    completionTokens,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
