import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, listUsers, type User } from '@agentdesk/db';

import { buildTools } from '../registry.js';
import type { BuiltTool, ToolContext } from '../tools/define.js';

/**
 * Tool behaviour against real seeded rows.
 *
 * The security property is the one that matters most here: a tool argument is
 * model-generated text, so the tests confirm that no argument can widen access
 * beyond the calling user. A model that hallucinates another customer's order
 * reference must get a not-found, never their data.
 */

let ada: User;
let milo: User;

const ctxFor = (userId: string): ToolContext => ({
  userId,
  conversationId: null,
  timeoutMs: 5000,
});

// The AI SDK calls `execute(input, { toolCallId })`; mirror that here.
async function call(tool: BuiltTool, input: unknown): Promise<unknown> {
  const execute = (tool.tool as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  return execute(tool.inputSchema.parse(input), { toolCallId: 'test-call' });
}

function toolNamed(userId: string, agent: 'order' | 'billing' | 'support', name: string): BuiltTool {
  const found = buildTools(agent, ctxFor(userId)).find((tool) => tool.name === name);
  if (!found) throw new Error(`No tool named ${name} on the ${agent} agent.`);
  return found;
}

beforeAll(async () => {
  const users = await listUsers();
  const foundAda = users.find((user) => user.name.startsWith('Ada'));
  const foundMilo = users.find((user) => user.name.startsWith('Milo'));

  if (!foundAda || !foundMilo) throw new Error('Seed data is missing the expected demo users.');

  ada = foundAda;
  milo = foundMilo;
});

afterAll(async () => {
  await closeDb();
});

describe('order tools', () => {
  it('returns the order when it belongs to the caller', async () => {
    const result = (await call(toolNamed(ada.id, 'order', 'getOrderDetails'), {
      orderReference: 'AD-10604',
    })) as Record<string, unknown>;

    expect(result.reference).toBe('AD-10604');
    expect(result.status).toBe('shipped');
  });

  it('refuses another customer\'s order even when the reference is valid', async () => {
    // AD-10604 is Ada's. Milo asking for it by exact reference must not get it.
    const result = (await call(toolNamed(milo.id, 'order', 'getOrderDetails'), {
      orderReference: 'AD-10604',
    })) as Record<string, unknown>;

    expect(result.notFound).toBe(true);
    expect(result.reference).toBeUndefined();
  });

  it('reports the carrier exception with its scan history', async () => {
    const result = (await call(toolNamed(ada.id, 'order', 'checkDeliveryStatus'), {
      orderReference: 'AD-10604',
    })) as Record<string, unknown>;

    expect(result.shipmentStatus).toBe('exception');
    expect(result.trackingNumber).toBe('CF88120477');
    expect(Array.isArray(result.events)).toBe(true);
    expect((result.events as unknown[]).length).toBeGreaterThan(0);
  });

  it('lists only the calling customer\'s orders', async () => {
    const adasOrders = (await call(toolNamed(ada.id, 'order', 'listOrders'), {
      limit: 20,
    })) as Array<{ reference: string }>;

    expect(adasOrders.length).toBeGreaterThan(0);
    // AD-10650 belongs to Milo.
    expect(adasOrders.map((order) => order.reference)).not.toContain('AD-10650');
  });

  it('queues a change request instead of cancelling the order itself', async () => {
    const result = (await call(toolNamed(ada.id, 'order', 'requestOrderChange'), {
      orderReference: 'AD-10711',
      action: 'cancel',
      reason: 'Ordered the wrong size.',
    })) as Record<string, unknown>;

    expect(result.submitted).toBe(true);
    expect(result.status).toBe('pending_review');

    // The order itself must be untouched — a queued request is not a cancellation.
    const order = (await call(toolNamed(ada.id, 'order', 'getOrderDetails'), {
      orderReference: 'AD-10711',
    })) as Record<string, unknown>;

    expect(order.status).toBe('processing');
    expect(order.cancelledAt).toBeNull();
  });

  it('declines a change once the order has shipped, and says why', async () => {
    const result = (await call(toolNamed(ada.id, 'order', 'requestOrderChange'), {
      orderReference: 'AD-10604',
      action: 'cancel',
      reason: 'Changed my mind.',
    })) as Record<string, unknown>;

    expect(result.submitted).toBe(false);
    expect(String(result.reason)).toMatch(/shipped|return/i);
  });
});

describe('billing tools', () => {
  it('finds a refund by the order reference, not just the refund reference', async () => {
    // Customers know their order; they rarely know the refund id.
    const byOrder = (await call(toolNamed(ada.id, 'billing', 'checkRefundStatus'), {
      reference: 'AD-10432',
    })) as { refunds: Array<{ reference: string; status: string }> };

    expect(byOrder.refunds).toHaveLength(1);
    expect(byOrder.refunds[0]?.reference).toBe('RF-5619');
    expect(byOrder.refunds[0]?.status).toBe('processing');

    const byRefund = (await call(toolNamed(ada.id, 'billing', 'checkRefundStatus'), {
      reference: 'RF-5619',
    })) as { refunds: Array<{ reference: string }> };

    expect(byRefund.refunds[0]?.reference).toBe('RF-5619');
  });

  it('offers the customer\'s other refunds when the reference does not match', async () => {
    const result = (await call(toolNamed(ada.id, 'billing', 'checkRefundStatus'), {
      reference: 'AD-99999',
    })) as { refunds: unknown[]; otherRefunds?: unknown[] };

    expect(result.refunds).toHaveLength(0);
    expect(result.otherRefunds?.length).toBeGreaterThan(0);
  });

  it('surfaces the issuer decline reason on failed payments', async () => {
    const payments = (await call(toolNamed(milo.id, 'billing', 'listPayments'), {
      limit: 25,
    })) as Array<{ status: string; failureReason: string | null }>;

    const failures = payments.filter((payment) => payment.status === 'failed');

    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures.map((failure) => failure.failureReason)).toContain('card_expired');
  });

  it('scopes invoices to the caller', async () => {
    const invoices = (await call(toolNamed(ada.id, 'billing', 'listInvoices'), {
      limit: 20,
    })) as Array<{ number: string }>;

    // INV-2091 is Milo's.
    expect(invoices.map((invoice) => invoice.number)).not.toContain('INV-2091');
  });
});

describe('support tools', () => {
  it('searches only the calling customer\'s conversation history', async () => {
    const adasMatches = (await call(toolNamed(ada.id, 'support', 'searchConversationHistory'), {
      query: 'rattle',
      limit: 5,
    })) as unknown[];

    expect(adasMatches.length).toBeGreaterThan(0);

    // Rosa is new and has no history; the same query must find nothing for her.
    const users = await listUsers();
    const rosa = users.find((user) => user.name.startsWith('Rosa'));
    if (!rosa) throw new Error('Seed data is missing Rosa.');

    const rosasMatches = (await call(
      toolNamed(rosa.id, 'support', 'searchConversationHistory'),
      { query: 'rattle', limit: 5 },
    )) as unknown[];

    expect(rosasMatches).toHaveLength(0);
  });

  it('returns ordered remediation steps for a described fault', async () => {
    const result = (await call(toolNamed(ada.id, 'support', 'getTroubleshootingSteps'), {
      symptom: 'crackling',
      limit: 2,
    })) as { articles: Array<{ steps: string[] }> };

    expect(result.articles.length).toBeGreaterThan(0);
    expect(result.articles[0]?.steps.length).toBeGreaterThan(1);
  });

  it('lists the topics it does cover when nothing matches', async () => {
    const result = (await call(toolNamed(ada.id, 'support', 'getFaqArticle'), {
      topic: 'quantum tunnelling',
      limit: 3,
    })) as { articles: unknown[]; availableTopics?: string[] };

    expect(result.articles).toHaveLength(0);
    expect(result.availableTopics?.length).toBeGreaterThan(0);
  });
});

describe('tool instrumentation', () => {
  it('records every call in the trace with the SDK\'s own call id', async () => {
    const recorded: Array<{ callId: string; tool: string; ok: boolean; summary: string }> = [];

    const tools = buildTools('order', {
      ...ctxFor(ada.id),
      onToolCall: (entry) => recorded.push(entry),
    });

    const tool = tools.find((candidate) => candidate.name === 'getOrderDetails');
    if (!tool) throw new Error('getOrderDetails is missing.');

    await call(tool, { orderReference: 'AD-10432' });

    expect(recorded).toHaveLength(1);
    // Correlating tool-call with tool-result in the UI depends on this id
    // being the one the SDK issued, not one we generated.
    expect(recorded[0]?.callId).toBe('test-call');
    expect(recorded[0]?.ok).toBe(true);
    expect(recorded[0]?.summary).toContain('AD-10432');
  });
});
