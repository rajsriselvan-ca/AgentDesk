import { z } from 'zod';
import {
  changeEligibility,
  createActionRequest,
  getDeliveryStatus,
  getOrderDetail,
  listOrdersForUser,
} from '@agentdesk/db';

import { defineTool } from './define.js';

/** Tools for the order agent. Every read is filtered by the caller's user id. */

export const listOrdersTool = defineTool({
  name: 'listOrders',
  description:
    "List the customer's recent orders, newest first. Use this when they refer to an order without giving a reference, or ask what they have ordered lately. Optionally filter by status.",
  inputSchema: z.object({
    status: z
      .enum(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'returned'])
      .optional()
      .describe('Only return orders in this state.'),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  execute: (input, ctx) =>
    listOrdersForUser(ctx.userId, { status: input.status, limit: input.limit }),
  summarize: (orders) =>
    orders.length === 0 ? 'no orders found' : `${orders.length} order(s)`,
});

export const getOrderDetailsTool = defineTool({
  name: 'getOrderDetails',
  description:
    'Fetch one order in full: line items, totals, status, and cancellation details. Takes the order reference the customer quotes, such as AD-10432.',
  inputSchema: z.object({
    orderReference: z.string().min(1).describe('The order reference, e.g. AD-10432.'),
  }),
  execute: async (input, ctx) => {
    const order = await getOrderDetail(ctx.userId, input.orderReference);
    return order ?? { notFound: true as const, orderReference: input.orderReference };
  },
  summarize: (order) =>
    'notFound' in order ? `no order ${order.orderReference}` : `${order.reference} · ${order.status}`,
});

export const checkDeliveryStatusTool = defineTool({
  name: 'checkDeliveryStatus',
  description:
    'Get carrier, tracking number, estimated delivery, and the full scan history for an order. Use this for "where is my parcel" and any question about delays.',
  inputSchema: z.object({
    orderReference: z.string().min(1).describe('The order reference, e.g. AD-10604.'),
  }),
  execute: async (input, ctx) => {
    const delivery = await getDeliveryStatus(ctx.userId, input.orderReference);
    return delivery ?? { notFound: true as const, orderReference: input.orderReference };
  },
  summarize: (delivery) => {
    if ('notFound' in delivery) return `no order ${delivery.orderReference}`;
    return delivery.shipmentStatus
      ? `${delivery.orderReference} · ${delivery.shipmentStatus}`
      : `${delivery.orderReference} · not yet dispatched`;
  },
});

/**
 * Requests a change; does not make one.
 *
 * Eligibility is decided by a plain function on the order's status, not by the
 * model, and the outcome is a queued request for human review. This is the
 * boundary that stops a confidently wrong model from cancelling a real order.
 */
export const requestOrderChangeTool = defineTool({
  name: 'requestOrderChange',
  description:
    'Submit a cancellation or modification request for human review. This does NOT cancel the order itself — it queues the request and returns whether the order is still eligible. Always tell the customer it has been queued, never that it is done.',
  inputSchema: z.object({
    orderReference: z.string().min(1),
    action: z.enum(['cancel', 'change_address', 'change_items']),
    reason: z.string().min(1).max(500).describe("The customer's stated reason."),
  }),
  execute: async (input, ctx) => {
    const order = await getOrderDetail(ctx.userId, input.orderReference);
    if (!order) return { notFound: true as const, orderReference: input.orderReference };

    const eligibility = changeEligibility(order.status);
    if (!eligibility.allowed) {
      return {
        submitted: false as const,
        orderReference: order.reference,
        orderStatus: order.status,
        reason: eligibility.reason,
      };
    }

    const request = await createActionRequest({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      kind: input.action,
      targetReference: order.reference,
      detail: input.reason,
    });

    return {
      submitted: true as const,
      requestId: request.id,
      status: request.status,
      orderReference: order.reference,
      orderStatus: order.status,
      note: eligibility.reason,
    };
  },
  summarize: (result) => {
    if ('notFound' in result) return `no order ${result.orderReference}`;
    return result.submitted
      ? `queued for review · ${result.orderReference}`
      : `not eligible · ${result.orderReference}`;
  },
});

export const orderToolFactories = [
  listOrdersTool,
  getOrderDetailsTool,
  checkDeliveryStatusTool,
  requestOrderChangeTool,
];
