import { useCallback, useRef, useState } from 'react';
import type {
  AgentType,
  ChatStreamEvent,
  MessageDTO,
  ToolCallDTO,
  TurnPhase,
} from '@agentdesk/core';

import { streamChatMessage } from './sse.js';

/**
 * The chat turn state machine.
 *
 * Everything the UI shows during a turn is a projection of the event stream:
 * the live indicator is the latest `status`, the trace is the accumulated
 * routing decision plus tool events, and the reply is the concatenated text
 * deltas. Nothing is inferred or faked — if the UI claims a tool is running,
 * the server said so.
 */

export interface LiveTurn {
  phase: TurnPhase;
  detail: string | null;
  agent: AgentType | null;
  confidence: number | null;
  reasoning: string | null;
  fellBack: boolean;
  toolCalls: ToolCallDTO[];
  /** Tools that have started but not yet returned. */
  pendingTools: Array<{ callId: string; tool: string }>;
  text: string;
}

export interface ChatError {
  message: string;
  retryable: boolean;
  /** True when the stream died mid-turn rather than reporting an error event. */
  transport: boolean;
}

const emptyTurn: LiveTurn = {
  phase: 'received',
  detail: null,
  agent: null,
  confidence: null,
  reasoning: null,
  fellBack: false,
  toolCalls: [],
  pendingTools: [],
  text: '',
};

export interface UseChatOptions {
  onConversationCreated: (conversationId: string, title: string) => void;
  onTurnComplete: () => void;
}

export function useChat(options: UseChatOptions) {
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [turn, setTurn] = useState<LiveTurn | null>(null);
  const [error, setError] = useState<ChatError | null>(null);

  const abortRef = useRef<(() => void) | null>(null);
  const lastRequestRef = useRef<{ conversationId?: string | undefined; content: string } | null>(
    null,
  );

  const reset = useCallback((initial: MessageDTO[]) => {
    abortRef.current?.();
    abortRef.current = null;
    setMessages(initial);
    setTurn(null);
    setError(null);
  }, []);

  const handleEvent = useCallback(
    (event: ChatStreamEvent) => {
      switch (event.type) {
        case 'status':
          setTurn((current) => ({
            ...(current ?? emptyTurn),
            phase: event.phase,
            detail: event.detail ?? null,
          }));
          break;

        case 'conversation':
          options.onConversationCreated(event.conversationId, event.title);
          break;

        case 'user-message':
          // Replace the optimistic message with the persisted one so the id is
          // real before anything else references it.
          setMessages((current) => [
            ...current.filter((message) => !message.id.startsWith('pending-')),
            event.message,
          ]);
          break;

        case 'routed':
          setTurn((current) => ({
            ...(current ?? emptyTurn),
            agent: event.agent,
            confidence: event.confidence,
            reasoning: event.reasoning,
            fellBack: event.fellBack,
          }));
          break;

        case 'tool-call':
          setTurn((current) => ({
            ...(current ?? emptyTurn),
            pendingTools: [
              ...(current?.pendingTools ?? []),
              { callId: event.callId, tool: event.tool },
            ],
          }));
          break;

        case 'tool-result':
          setTurn((current) => ({
            ...(current ?? emptyTurn),
            pendingTools: (current?.pendingTools ?? []).filter(
              (pending) => pending.callId !== event.callId,
            ),
            toolCalls: [
              ...(current?.toolCalls ?? []),
              {
                callId: event.callId,
                tool: event.tool,
                args: {},
                ok: event.ok,
                summary: event.summary,
                durationMs: event.durationMs,
              },
            ],
          }));
          break;

        case 'text-delta':
          setTurn((current) => ({
            ...(current ?? emptyTurn),
            text: (current?.text ?? '') + event.text,
          }));
          break;

        case 'done':
          setMessages((current) => [...current, event.message]);
          setTurn(null);
          options.onTurnComplete();
          break;

        case 'error':
          setError({ message: event.message, retryable: event.retryable, transport: false });
          setTurn(null);
          break;
      }
    },
    [options],
  );

  const send = useCallback(
    (content: string, conversationId: string | undefined) => {
      setError(null);
      lastRequestRef.current = { conversationId, content };

      // Show the customer's own message immediately; the server replaces it
      // with the persisted row a moment later.
      setMessages((current) => [
        ...current,
        {
          id: `pending-${Date.now()}`,
          conversationId: conversationId ?? '',
          role: 'user',
          content,
          agent: null,
          createdAt: new Date().toISOString(),
          trace: null,
        },
      ]);

      setTurn({ ...emptyTurn });

      const stream = streamChatMessage(
        { conversationId, content },
        {
          onEvent: handleEvent,
          onTransportError: (transportError) => {
            setError({ message: transportError.message, retryable: true, transport: true });
            setTurn(null);
          },
          onClose: () => {
            abortRef.current = null;
            // A stream that closed without a `done` or `error` event ended
            // mid-turn — say so rather than leaving a half-written reply that
            // looks finished.
            setTurn((current) => {
              if (current && current.text.length > 0) {
                setError({
                  message: 'The connection dropped before the reply finished.',
                  retryable: true,
                  transport: true,
                });
              }
              return null;
            });
          },
        },
      );

      abortRef.current = stream.abort;
    },
    [handleEvent],
  );

  const stop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    setTurn(null);
  }, []);

  const retry = useCallback(() => {
    const last = lastRequestRef.current;
    if (!last) return;

    setMessages((current) => current.filter((message) => !message.id.startsWith('pending-')));
    send(last.content, last.conversationId);
  }, [send]);

  return { messages, turn, error, send, stop, retry, reset, setMessages };
}
