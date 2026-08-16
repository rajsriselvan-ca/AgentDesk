import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, listUsers, type User } from '@agentdesk/db';
import { parseChatStreamEvent, type ChatStreamEvent } from '@agentdesk/core';

import app from '../app.js';
import { resetRateLimits } from '../middleware/rate-limit.js';

/**
 * API integration tests.
 *
 * These drive the real Hono app with `app.request()` — real routing, real
 * middleware, real services, real database. No HTTP server and no mocking of
 * the layers under test, so a break anywhere between the route and Postgres
 * shows up here.
 */

let ada: User;
let milo: User;

const as = (user: User, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), 'x-user-id': user.id },
});

/** Drive a chat turn and collect the parsed SSE events. */
async function sendMessage(user: User, body: unknown): Promise<ChatStreamEvent[]> {
  const response = await app.request(
    '/api/chat/messages',
    as(user, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

  expect(response.status).toBe(200);

  const text = await response.text();
  const events: ChatStreamEvent[] = [];

  for (const frame of text.split('\n\n')) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const event = parseChatStreamEvent(line.slice(5).trim());
      if (event) events.push(event);
    }
  }

  return events;
}

beforeAll(async () => {
  const users = await listUsers();
  const foundAda = users.find((user) => user.name.startsWith('Ada'));
  const foundMilo = users.find((user) => user.name.startsWith('Milo'));
  if (!foundAda || !foundMilo) throw new Error('Seed data is missing the demo users.');
  ada = foundAda;
  milo = foundMilo;
});

beforeEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await closeDb();
});

describe('GET /health', () => {
  it('reports the database and provider', async () => {
    const response = await app.request('/health');
    const body = (await response.json()) as {
      status: string;
      checks: { database: { ok: boolean }; modelProvider: { ok: boolean; provider: string } };
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.modelProvider.provider).toBe('mock');
  });
});

describe('authentication', () => {
  it('rejects a request with no identity', async () => {
    const response = await app.request('/api/chat/conversations');
    const body = (await response.json()) as { error: { code: string; requestId: string } };

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
    // Every error carries the id needed to find its log line.
    expect(body.error.requestId).toBeTruthy();
  });

  it('rejects an identity that is not a real user', async () => {
    const response = await app.request('/api/chat/conversations', {
      headers: { 'x-user-id': '11111111-1111-1111-1111-111111111111' },
    });

    expect(response.status).toBe(401);
  });
});

describe('POST /api/chat/messages', () => {
  it('streams a complete turn and persists it', async () => {
    const events = await sendMessage(ada, { content: 'Where is my order AD-10604?' });

    const types = events.map((event) => event.type);
    expect(types).toContain('conversation');
    expect(types).toContain('user-message');
    expect(types).toContain('routed');
    expect(types).toContain('text-delta');

    // A turn must always terminate with exactly one done or one error.
    const terminal = events.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.type).toBe('done');

    const routed = events.find((event) => event.type === 'routed');
    expect(routed?.type === 'routed' && routed.agent).toBe('order');

    const done = events.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('Expected a done event.');

    expect(done.message.content.length).toBeGreaterThan(0);
    expect(done.message.trace?.toolCalls.length).toBeGreaterThan(0);

    // And it is readable back through the API.
    const detail = await app.request(
      `/api/chat/conversations/${done.message.conversationId}`,
      as(ada),
    );
    const body = (await detail.json()) as { messages: unknown[] };

    expect(detail.status).toBe(200);
    expect(body.messages).toHaveLength(2);
  });

  it('pairs every tool-call with a tool-result under the same id', async () => {
    const events = await sendMessage(ada, { content: 'Where is my order AD-10604?' });

    const calls = events.filter((event) => event.type === 'tool-call');
    const results = events.filter((event) => event.type === 'tool-result');

    expect(calls.length).toBeGreaterThan(0);
    expect(results.length).toBe(calls.length);

    // Without matching ids the UI cannot pair a running tool with its outcome.
    for (const call of calls) {
      if (call.type !== 'tool-call') continue;
      expect(results.some((r) => r.type === 'tool-result' && r.callId === call.callId)).toBe(true);
    }
  });

  it('routes a billing question to the billing agent', async () => {
    const events = await sendMessage(ada, { content: 'Where is my refund for AD-10432?' });
    const routed = events.find((event) => event.type === 'routed');

    expect(routed?.type === 'routed' && routed.agent).toBe('billing');
  });

  it('falls back rather than guessing on a greeting', async () => {
    const events = await sendMessage(ada, { content: 'hello' });
    const routed = events.find((event) => event.type === 'routed');

    expect(routed?.type === 'routed' && routed.agent).toBe('fallback');
  });

  it('continues an existing conversation instead of starting a new one', async () => {
    const first = await sendMessage(ada, { content: 'Where is my order AD-10604?' });
    const created = first.find((event) => event.type === 'conversation');
    if (created?.type !== 'conversation') throw new Error('Expected a conversation event.');

    const second = await sendMessage(ada, {
      conversationId: created.conversationId,
      content: 'And when will it arrive?',
    });

    // No second conversation should be created.
    expect(second.some((event) => event.type === 'conversation')).toBe(false);

    const detail = await app.request(
      `/api/chat/conversations/${created.conversationId}`,
      as(ada),
    );
    const body = (await detail.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(4);
  });

  it('rejects an empty message', async () => {
    const response = await app.request(
      '/api/chat/messages',
      as(ada, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '   ' }),
      }),
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects posting into somebody else\'s conversation', async () => {
    const events = await sendMessage(ada, { content: 'Where is my order AD-10604?' });
    const created = events.find((event) => event.type === 'conversation');
    if (created?.type !== 'conversation') throw new Error('Expected a conversation event.');

    const response = await app.request(
      '/api/chat/messages',
      as(milo, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: created.conversationId, content: 'hello' }),
      }),
    );

    // The stream opens, then reports the failure as an event.
    const text = await response.text();
    expect(text).toContain('NOT_FOUND');
  });
});

describe('conversations', () => {
  it('lists with accurate counts and previews', async () => {
    await sendMessage(ada, { content: 'Where is my order AD-10604?' });

    const response = await app.request('/api/chat/conversations?limit=5', as(ada));
    const body = (await response.json()) as {
      items: Array<{ messageCount: number; lastMessagePreview: string | null; lastAgent: string | null }>;
    };

    expect(response.status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);

    const [newest] = body.items;
    // Regression guard: a correlated-subquery bug once reported 0 for every row.
    expect(newest?.messageCount).toBeGreaterThan(0);
    expect(newest?.lastMessagePreview).toBeTruthy();
    expect(newest?.lastAgent).toBeTruthy();
  });

  it('paginates by cursor', async () => {
    const first = await app.request('/api/chat/conversations?limit=1', as(ada));
    const firstBody = (await first.json()) as { items: Array<{ id: string }>; nextCursor: string | null };

    expect(firstBody.items).toHaveLength(1);

    if (firstBody.nextCursor) {
      const second = await app.request(
        `/api/chat/conversations?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
        as(ada),
      );
      const secondBody = (await second.json()) as { items: Array<{ id: string }> };

      expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id);
    }
  });

  it('answers 404 rather than 403 for another user\'s conversation', async () => {
    const events = await sendMessage(ada, { content: 'Where is my order AD-10604?' });
    const created = events.find((event) => event.type === 'conversation');
    if (created?.type !== 'conversation') throw new Error('Expected a conversation event.');

    const response = await app.request(
      `/api/chat/conversations/${created.conversationId}`,
      as(milo),
    );

    // 403 would confirm the id exists, which is an existence leak.
    expect(response.status).toBe(404);
  });

  it('rejects a malformed conversation id', async () => {
    const response = await app.request('/api/chat/conversations/not-a-uuid', as(ada));
    expect(response.status).toBe(400);
  });

  it('deletes once, then reports not found', async () => {
    const events = await sendMessage(ada, { content: 'Where is my order AD-10604?' });
    const created = events.find((event) => event.type === 'conversation');
    if (created?.type !== 'conversation') throw new Error('Expected a conversation event.');

    const first = await app.request(
      `/api/chat/conversations/${created.conversationId}`,
      as(ada, { method: 'DELETE' }),
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      `/api/chat/conversations/${created.conversationId}`,
      as(ada, { method: 'DELETE' }),
    );
    expect(second.status).toBe(404);
  });
});

describe('agents', () => {
  it('lists every agent', async () => {
    const response = await app.request('/api/agents');
    const body = (await response.json()) as { agents: Array<{ type: string; toolCount: number }> };

    expect(response.status).toBe(200);
    expect(body.agents.map((agent) => agent.type).sort()).toEqual([
      'billing',
      'fallback',
      'order',
      'support',
    ]);
  });

  it('describes capabilities from the live tool schemas', async () => {
    const response = await app.request('/api/agents/billing/capabilities');
    const body = (await response.json()) as {
      tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
    };

    expect(response.status).toBe(200);
    expect(body.tools.map((tool) => tool.name)).toContain('checkRefundStatus');

    const refundTool = body.tools.find((tool) => tool.name === 'checkRefundStatus');
    expect(Object.keys(refundTool?.inputSchema.properties ?? {})).toContain('reference');
  });

  it('rejects an unknown agent type', async () => {
    const response = await app.request('/api/agents/nonsense/capabilities');
    expect(response.status).toBe(400);
  });
});

describe('rate limiting', () => {
  it('returns 429 with a Retry-After once the chat budget is spent', async () => {
    const limit = Number(process.env.RATE_LIMIT_CHAT_MAX ?? 15);
    let lastStatus = 200;

    // One past the limit: the final request must be refused.
    for (let attempt = 0; attempt <= limit; attempt += 1) {
      const response = await app.request(
        '/api/chat/messages',
        as(ada, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'hello' }),
        }),
      );
      lastStatus = response.status;

      if (response.status === 429) {
        expect(response.headers.get('Retry-After')).toBeTruthy();
        expect(response.headers.get('RateLimit-Remaining')).toBe('0');
        break;
      }
    }

    expect(lastStatus).toBe(429);
  });

  it('advertises the remaining allowance on reads', async () => {
    const response = await app.request('/api/chat/conversations', as(ada));

    expect(response.headers.get('RateLimit-Limit')).toBeTruthy();
    expect(Number(response.headers.get('RateLimit-Remaining'))).toBeGreaterThanOrEqual(0);
  });
});

describe('unknown routes', () => {
  it('answers 404 in the standard error shape', async () => {
    const response = await app.request('/api/nope');
    const body = (await response.json()) as { error: { code: string; requestId: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBeTruthy();
  });
});
