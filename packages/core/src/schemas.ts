import { z } from 'zod';
import { agentTypeSchema } from './agents.js';

/**
 * Request validation schemas.
 *
 * These live in core rather than beside the routes because the browser uses
 * the same schemas to validate before sending — the client cannot drift from
 * what the server accepts.
 */

export const uuidSchema = z.uuid('Expected a UUID.');

export const sendMessageSchema = z.object({
  /** Omit to start a new conversation. */
  conversationId: uuidSchema.optional(),
  content: z
    .string()
    .trim()
    .min(1, 'A message cannot be empty.')
    .max(4000, 'Messages are limited to 4000 characters.'),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const listConversationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const conversationParamSchema = z.object({
  id: uuidSchema,
});

export const agentParamSchema = z.object({
  type: agentTypeSchema,
});
