import { z } from 'zod';
import {
  findRefunds,
  getInvoice,
  getSubscription,
  listInvoices,
  listPayments,
  listRefunds,
} from '@agentdesk/db';

import { defineTool } from './define.js';

/** Tools for the billing agent. Every read is filtered by the caller's user id. */

export const getInvoiceTool = defineTool({
  name: 'getInvoice',
  description:
    'Fetch one invoice with its full payment attempt history, including the decline reason on any failed attempt. Takes an invoice number such as INV-2091.',
  inputSchema: z.object({
    invoiceNumber: z.string().min(1).describe('Invoice number, e.g. INV-2091.'),
  }),
  execute: async (input, ctx) => {
    const invoice = await getInvoice(ctx.userId, input.invoiceNumber);
    return invoice ?? { notFound: true as const, invoiceNumber: input.invoiceNumber };
  },
  summarize: (invoice) =>
    'notFound' in invoice
      ? `no invoice ${invoice.invoiceNumber}`
      : `${invoice.number} · ${invoice.status}`,
});

export const listInvoicesTool = defineTool({
  name: 'listInvoices',
  description:
    "List the customer's invoices, newest first. Use this when they have not given an invoice number, or ask what they owe.",
  inputSchema: z.object({
    status: z.enum(['draft', 'open', 'paid', 'overdue', 'void', 'refunded']).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  execute: (input, ctx) => listInvoices(ctx.userId, { status: input.status, limit: input.limit }),
  summarize: (invoices) =>
    invoices.length === 0 ? 'no invoices found' : `${invoices.length} invoice(s)`,
});

export const listPaymentsTool = defineTool({
  name: 'listPayments',
  description:
    'List payment attempts including failures, with the issuer decline reason. Use this for "why was my card declined" and for reconciling what was actually charged.',
  inputSchema: z.object({
    since: z.string().optional().describe('ISO date; only attempts on or after this.'),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  execute: (input, ctx) => listPayments(ctx.userId, { since: input.since, limit: input.limit }),
  summarize: (payments) => {
    if (payments.length === 0) return 'no payments found';
    const failed = payments.filter((p) => p.status === 'failed').length;
    return failed > 0
      ? `${payments.length} payment(s), ${failed} failed`
      : `${payments.length} payment(s)`;
  },
});

export const checkRefundStatusTool = defineTool({
  name: 'checkRefundStatus',
  description:
    'Look up a refund by its own reference (RF-5619) OR by the order it belongs to (AD-10432). Customers usually know the order, not the refund, so pass whichever they gave you. Returns the expected settlement timing while a refund is still in flight.',
  inputSchema: z.object({
    reference: z
      .string()
      .min(1)
      .describe('A refund reference or an order reference — either works.'),
  }),
  execute: async (input, ctx) => {
    const matches = await findRefunds(ctx.userId, input.reference);
    if (matches.length > 0) return { refunds: matches };

    // Rather than a bare "not found", hand back what does exist so the agent
    // can say "no refund for that order, but here is the one you do have".
    const all = await listRefunds(ctx.userId, 5);
    return { refunds: [], notFoundFor: input.reference, otherRefunds: all };
  },
  summarize: (result) =>
    result.refunds.length > 0
      ? `${result.refunds.length} refund(s) · ${result.refunds[0]?.status ?? ''}`
      : `no refund for ${'notFoundFor' in result ? result.notFoundFor : 'that reference'}`,
});

export const getSubscriptionTool = defineTool({
  name: 'getSubscription',
  description:
    "Fetch the customer's subscription: plan, status, price, current billing period, and whether it is set to cancel at period end.",
  inputSchema: z.object({}),
  execute: async (_input, ctx) => {
    const subscription = await getSubscription(ctx.userId);
    return subscription ?? { notFound: true as const };
  },
  summarize: (subscription) =>
    'notFound' in subscription
      ? 'no subscription'
      : `${subscription.plan} · ${subscription.status}`,
});

export const billingToolFactories = [
  getInvoiceTool,
  listInvoicesTool,
  listPaymentsTool,
  checkRefundStatusTool,
  getSubscriptionTool,
];
