import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import {
  ValidationError,
  conversationParamSchema,
  listConversationsQuerySchema,
  sendMessageSchema,
  toAppError,
  type ChatStreamEvent,
} from '@agentdesk/core';

import { getUser, type AppVariables } from '../lib/context.js';
import { identity } from '../middleware/identity.js';
import { rateLimit } from '../middleware/rate-limit.js';
import * as chatService from '../services/chat.service.js';

/**
 * Chat routes.
 *
 * Routes declare the path, the validation, and the middleware. The handlers do
 * HTTP work only — read validated input, call one service method, shape the
 * response. No Drizzle here, and no business rules.
 *
 * The chain is unbroken on purpose: Hono derives the RPC client's types from
 * this expression, and splitting it into separate `.get(...)` statements loses
 * that inference.
 */

// Zod failures become our error shape rather than Hono's default, so clients
// only ever have to parse one error format.
const validationHook = (result: { success: boolean; error?: unknown }) => {
  if (!result.success) {
    throw new ValidationError('The request did not match the expected shape.', result.error);
  }
};

export const chatRoutes = new Hono<{ Variables: AppVariables }>()
  .use('*', identity)

  /**
   * Send a message. Responds with an SSE stream rather than a single body.
   *
   * The stream opens before routing begins, so the client can show a truthful
   * "routing" state instead of an indeterminate spinner.
   */
  .post(
    '/messages',
    rateLimit('chat'),
    zValidator('json', sendMessageSchema, validationHook),
    async (c) => {
      const user = getUser(c);
      const input = c.req.valid('json');

      return streamSSE(c, async (stream) => {
        const controller = new AbortController();

        // A closed connection means the customer navigated away or hit stop.
        // Aborting stops us paying for tokens nobody will read.
        stream.onAbort(() => controller.abort());

        // `emit` is synchronous — the agent runtime should not have to await a
        // socket write between tokens — but `writeSSE` is async. Chaining the
        // writes keeps them strictly ordered, and awaiting the chain before
        // this callback returns is what makes them arrive at all: Hono closes
        // the stream as soon as the callback resolves, so fire-and-forget
        // writes lose whatever is still queued. In practice that silently drops
        // the terminal `done` event and the client sees a truncated turn.
        let writes: Promise<void> = Promise.resolve();

        const send = (event: ChatStreamEvent): void => {
          writes = writes
            .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
            .catch(() => {
              // The client went away mid-write. Nothing to do — the abort
              // handler has already stopped the work upstream.
            });
        };

        try {
          await chatService.sendMessage({
            userId: user.id,
            input,
            emit: send,
            signal: controller.signal,
          });
        } catch (error) {
          // The single place a failed turn is reported to the client. Every
          // failure lands here — validation, ownership, provider outage, agent
          // error — so the stream always terminates with a `done` or an
          // `error`, never by silently closing.
          const appError = toAppError(error);

          send({
            type: 'error',
            code: appError.code,
            message: appError.message,
            retryable: appError.retryable,
          });
        } finally {
          await writes;
        }
      });
    },
  )

  .get(
    '/conversations',
    rateLimit('read'),
    zValidator('query', listConversationsQuerySchema, validationHook),
    async (c) => {
      const user = getUser(c);
      const query = c.req.valid('query');

      return c.json(await chatService.listConversations(user.id, query));
    },
  )

  .get(
    '/conversations/:id',
    rateLimit('read'),
    zValidator('param', conversationParamSchema, validationHook),
    async (c) => {
      const user = getUser(c);
      const { id } = c.req.valid('param');

      return c.json(await chatService.getConversation(user.id, id));
    },
  )

  .delete(
    '/conversations/:id',
    rateLimit('read'),
    zValidator('param', conversationParamSchema, validationHook),
    async (c) => {
      const user = getUser(c);
      const { id } = c.req.valid('param');

      await chatService.deleteConversation(user.id, id);
      return c.json({ deleted: true as const, id });
    },
  );
