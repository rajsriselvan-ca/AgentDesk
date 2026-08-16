import type { AgentType } from './agents.js';
import type { ErrorCode } from './errors.js';
import type { MessageDTO } from './dto.js';

/**
 * The server-sent event contract for a single chat turn.
 *
 * The stream opens before the router has decided anything, so the UI can show
 * a truthful "routing" state rather than a spinner that means nothing. Every
 * phase after that pushes its own event: the typing indicator and the
 * reasoning trace are both just projections of this stream.
 *
 * A turn always terminates with exactly one `done` or one `error`.
 */

/** What the assistant is currently doing. Drives the live indicator. */
export type TurnPhase =
  | 'received'
  | 'routing'
  | 'thinking'
  | 'calling_tool'
  | 'writing'
  | 'compacting';

export interface StatusEvent {
  type: 'status';
  phase: TurnPhase;
  /** Human-readable elaboration, e.g. the tool being called. */
  detail?: string;
}

/** Emitted only when the turn created a new conversation. */
export interface ConversationEvent {
  type: 'conversation';
  conversationId: string;
  title: string;
}

/** Echoes the persisted user message so the optimistic UI can reconcile ids. */
export interface UserMessageEvent {
  type: 'user-message';
  message: MessageDTO;
}

/** The router's decision, including the rationale shown in the trace. */
export interface RoutedEvent {
  type: 'routed';
  agent: AgentType;
  confidence: number;
  reasoning: string;
  /** True when confidence fell below the threshold and fallback took over. */
  fellBack: boolean;
}

export interface ToolCallEvent {
  type: 'tool-call';
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool-result';
  callId: string;
  tool: string;
  ok: boolean;
  /** One line describing the outcome, e.g. "3 orders" or "no refund found". */
  summary: string;
  durationMs: number;
}

export interface TextDeltaEvent {
  type: 'text-delta';
  text: string;
}

export interface DoneEvent {
  type: 'done';
  message: MessageDTO;
  agent: AgentType;
  usage: {
    promptTokens: number;
    completionTokens: number;
    toolCalls: number;
    durationMs: number;
  };
}

export interface ErrorEvent {
  type: 'error';
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export type ChatStreamEvent =
  | StatusEvent
  | ConversationEvent
  | UserMessageEvent
  | RoutedEvent
  | ToolCallEvent
  | ToolResultEvent
  | TextDeltaEvent
  | DoneEvent
  | ErrorEvent;

export type ChatStreamEventType = ChatStreamEvent['type'];

/**
 * Parse one SSE `data:` payload back into a typed event.
 *
 * Returns null rather than throwing on malformed input: a single bad frame
 * should not tear down a stream that is otherwise delivering fine.
 */
export function parseChatStreamEvent(raw: string): ChatStreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      return parsed as ChatStreamEvent;
    }
    return null;
  } catch {
    return null;
  }
}
