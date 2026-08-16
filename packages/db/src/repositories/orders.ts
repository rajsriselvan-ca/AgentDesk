import { and, desc, eq, or, sql } from 'drizzle-orm';

import { db } from '../client.js';
import { actionRequests, orderItems, orders, shipments } from '../schema.js';

/**
 * Order reads for the order agent's tools.
 *
 * Every function's first parameter is `userId`, supplied by the request
 * context rather than by the model. A hallucinated order reference resolves
 * to nothing rather than to somebody else's order.
 */

export interface OrderSummary {
  reference: string;
  status: string;
  placedAt: string;
  total: string;
  currency: string;
  itemCount: number;
}

export interface OrderDetail extends OrderSummary {
  subtotal: string;
  shippingCost: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
  items: Array<{ sku: string; name: string; quantity: number; unitPrice: string }>;
}

export interface DeliveryStatus {
  orderReference: string;
  orderStatus: string;
  carrier: string | null;
  trackingNumber: string | null;
  shipmentStatus: string | null;
  estimatedDelivery: string | null;
  deliveredAt: string | null;
  events: Array<{ at: string; location: string; description: string }>;
}

export async function listOrdersForUser(
  userId: string,
  options: { status?: string | undefined; limit: number },
): Promise<OrderSummary[]> {
  const rows = await db
    .select({
      reference: orders.reference,
      status: orders.status,
      placedAt: orders.placedAt,
      total: orders.total,
      currency: orders.currency,
      itemCount: sql<number>`(
        select coalesce(sum(oi.quantity), 0)::int from ${orderItems} oi
        where oi.order_id = ${orders.id}
      )`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        options.status ? sql`${orders.status}::text = ${options.status}` : undefined,
      ),
    )
    .orderBy(desc(orders.placedAt))
    .limit(options.limit);

  return rows.map((row) => ({ ...row, placedAt: row.placedAt.toISOString() }));
}

/** Accepts the human-facing reference (AD-10432) or the internal UUID. */
export async function getOrderDetail(
  userId: string,
  orderRef: string,
): Promise<OrderDetail | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.userId, userId), matchesOrderRef(orderRef)))
    .limit(1);

  if (!order) return null;

  const items = await db
    .select({
      sku: orderItems.sku,
      name: orderItems.name,
      quantity: orderItems.quantity,
      unitPrice: orderItems.unitPrice,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  return {
    reference: order.reference,
    status: order.status,
    placedAt: order.placedAt.toISOString(),
    total: order.total,
    currency: order.currency,
    subtotal: order.subtotal,
    shippingCost: order.shippingCost,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    cancellationReason: order.cancellationReason,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    items,
  };
}

export async function getDeliveryStatus(
  userId: string,
  orderRef: string,
): Promise<DeliveryStatus | null> {
  const [order] = await db
    .select({ id: orders.id, reference: orders.reference, status: orders.status })
    .from(orders)
    .where(and(eq(orders.userId, userId), matchesOrderRef(orderRef)))
    .limit(1);

  if (!order) return null;

  const [shipment] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, order.id))
    .orderBy(desc(shipments.id))
    .limit(1);

  return {
    orderReference: order.reference,
    orderStatus: order.status,
    carrier: shipment?.carrier ?? null,
    trackingNumber: shipment?.trackingNumber ?? null,
    shipmentStatus: shipment?.status ?? null,
    estimatedDelivery: shipment?.estimatedDelivery?.toISOString() ?? null,
    deliveredAt: shipment?.deliveredAt?.toISOString() ?? null,
    events: shipment?.events ?? [],
  };
}

/**
 * Whether an order can still be changed, and why not if it cannot.
 *
 * The rule lives here rather than in the agent's prompt so it is deterministic
 * and testable — a model should not be deciding cancellation eligibility.
 */
export function changeEligibility(status: string): { allowed: boolean; reason: string } {
  switch (status) {
    case 'pending':
    case 'confirmed':
      return { allowed: true, reason: 'The order has not entered fulfilment yet.' };
    case 'processing':
      return {
        allowed: true,
        reason: 'The order is being picked; a change may not reach the warehouse in time.',
      };
    case 'shipped':
    case 'out_for_delivery':
      return { allowed: false, reason: 'The order has already shipped and must be returned instead.' };
    case 'delivered':
      return { allowed: false, reason: 'The order was delivered; this is a return, not a cancellation.' };
    case 'cancelled':
      return { allowed: false, reason: 'The order is already cancelled.' };
    case 'returned':
      return { allowed: false, reason: 'The order was already returned.' };
    default:
      return { allowed: false, reason: 'The order is not in a changeable state.' };
  }
}

/**
 * Record a requested change for human review.
 *
 * Deliberately does not mutate the order. An agent can ask for a cancellation;
 * only a person grants one.
 */
export async function createActionRequest(input: {
  userId: string;
  conversationId: string | null;
  kind: string;
  targetReference: string;
  detail: string;
}): Promise<{ id: string; status: string }> {
  const [row] = await db
    .insert(actionRequests)
    .values({
      userId: input.userId,
      conversationId: input.conversationId,
      kind: input.kind,
      targetReference: input.targetReference,
      detail: input.detail,
    })
    .returning({ id: actionRequests.id, status: actionRequests.status });

  if (!row) throw new Error('Action request insert returned no row.');
  return row;
}

function matchesOrderRef(orderRef: string) {
  const trimmed = orderRef.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);

  return isUuid
    ? or(eq(orders.id, trimmed), sql`upper(${orders.reference}) = upper(${trimmed})`)
    : sql`upper(${orders.reference}) = upper(${trimmed})`;
}
