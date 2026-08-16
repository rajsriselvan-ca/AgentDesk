import { z } from 'zod';

/**
 * The four handlers a conversation turn can land on.
 *
 * `fallback` is a real destination, not an error path: it answers from
 * conversation context alone and tells the caller what the desk can actually
 * do. Anything the router cannot place with confidence ends up here.
 */
export const AGENT_TYPES = ['support', 'order', 'billing', 'fallback'] as const;

export const agentTypeSchema = z.enum(AGENT_TYPES);
export type AgentType = z.infer<typeof agentTypeSchema>;

/**
 * What the router returns. `reasoning` is surfaced in the UI trace, so it is
 * written for a person reading it, not for a log file.
 */
export const routingDecisionSchema = z.object({
  intent: agentTypeSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(400),
});

export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

/** Below this, the router's pick is discarded and the turn goes to fallback. */
export const ROUTING_CONFIDENCE_THRESHOLD = 0.6;

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema derived from the tool's own Zod input schema. */
  inputSchema: unknown;
}

export interface AgentCapabilities {
  type: AgentType;
  name: string;
  description: string;
  handles: string[];
  exampleQueries: string[];
  tools: ToolDescriptor[];
}

export interface AgentSummary {
  type: AgentType;
  name: string;
  description: string;
  toolCount: number;
}
