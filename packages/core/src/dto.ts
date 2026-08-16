import type { AgentType } from './agents.js';

/**
 * The shapes crossing the wire.
 *
 * These are deliberately not the Drizzle row types. Repositories map rows to
 * these, which keeps column renames from leaking into the API contract and
 * keeps internal columns (soft-delete flags, raw provider payloads) off the
 * wire entirely.
 */

export type MessageRole = 'user' | 'assistant';

export interface ToolCallDTO {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  durationMs: number;
}

/** The routing decision and tool trail behind one assistant message. */
export interface AgentTraceDTO {
  agent: AgentType;
  confidence: number;
  reasoning: string;
  fellBack: boolean;
  toolCalls: ToolCallDTO[];
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  agent: AgentType | null;
  createdAt: string;
  /** Present on assistant messages only. */
  trace: AgentTraceDTO | null;
}

export interface ConversationSummaryDTO {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  lastAgent: AgentType | null;
}

export interface ConversationDetailDTO extends ConversationSummaryDTO {
  messages: MessageDTO[];
  /** The rolling summary standing in for compacted history, if any. */
  summary: string | null;
}

export interface UserDTO {
  id: string;
  name: string;
  email: string;
  tier: string;
}

export interface PaginatedDTO<T> {
  items: T[];
  nextCursor: string | null;
}

export interface HealthDTO {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checks: {
    database: { ok: boolean; latencyMs: number | null; error?: string };
    modelProvider: { ok: boolean; provider: string; error?: string };
  };
}
