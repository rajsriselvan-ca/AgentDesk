import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * AgentDesk schema.
 *
 * Two groups of tables live here and they are deliberately not mixed:
 *
 *   Conversation state — users, conversations, messages, agent_runs. Written
 *   by the chat pipeline on every turn.
 *
 *   Business records — orders, shipments, invoices, payments, refunds,
 *   subscriptions, faq_articles. Read-only from the agents' point of view.
 *   This is the data the tools actually query, standing in for the systems a
 *   real support desk would federate over.
 *
 * Money is `numeric(12, 2)` throughout, never a float. Drizzle surfaces it as
 * a string, and the repositories convert to minor units at the boundary so no
 * arithmetic ever touches a binary fraction.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant']);

export const agentTypeEnum = pgEnum('agent_type', ['support', 'order', 'billing', 'fallback']);

export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
]);

export const shipmentStatusEnum = pgEnum('shipment_status', [
  'label_created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'returned_to_sender',
]);

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',
  'open',
  'paid',
  'overdue',
  'void',
  'refunded',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'succeeded',
  'failed',
  'pending',
  'refunded',
]);

export const refundStatusEnum = pgEnum('refund_status', [
  'requested',
  'approved',
  'processing',
  'completed',
  'rejected',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'trialing',
  'past_due',
  'cancelled',
]);

/** Staged write actions. The model requests; a human approves. */
export const actionRequestStatusEnum = pgEnum('action_request_status', [
  'pending_review',
  'approved',
  'rejected',
]);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    tier: text('tier').notNull().default('standard'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_key').on(table.email)],
);

// ---------------------------------------------------------------------------
// Conversation state
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),

    /**
     * Rolling summary of everything before `summarizedUptoMessageId`. Null
     * until the conversation first exceeds its context budget.
     */
    summary: text('summary'),
    summarizedUptoMessageId: uuid('summarized_upto_message_id'),

    /** Soft delete: the UI forgets it, the audit trail does not. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Serves the conversation list, which is always "mine, newest first,
    // excluding deleted".
    index('conversations_user_updated_idx')
      .on(table.userId, table.updatedAt.desc())
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),

    /** Which agent produced this. Null on user messages. */
    agent: agentTypeEnum('agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('messages_conversation_created_idx').on(table.conversationId, table.createdAt)],
);

/**
 * One row per assistant turn: how it was routed, what it called, what it cost.
 *
 * This is both the audit trail and the source of the reasoning panel in the
 * UI. Keeping it in its own table rather than as columns on `messages` means
 * the trace can be dropped for retention without touching the transcript.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    agent: agentTypeEnum('agent').notNull(),
    confidence: real('confidence').notNull(),
    reasoning: text('reasoning').notNull(),
    /** True when the router's pick was discarded for low confidence. */
    fellBack: boolean('fell_back').notNull().default(false),

    /** Ordered tool calls with arguments, outcome, and duration. */
    toolCalls: jsonb('tool_calls')
      .$type<
        Array<{
          callId: string;
          tool: string;
          args: Record<string, unknown>;
          ok: boolean;
          summary: string;
          durationMs: number;
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),

    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_runs_message_key').on(table.messageId),
    index('agent_runs_conversation_idx').on(table.conversationId),
  ],
);

// ---------------------------------------------------------------------------
// Business records — what the tools read
// ---------------------------------------------------------------------------

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Human-facing reference, e.g. AD-10432. What a customer actually quotes. */
    reference: text('reference').notNull(),

    status: orderStatusEnum('status').notNull(),
    currency: text('currency').notNull().default('USD'),
    subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull(),
    shippingCost: numeric('shipping_cost', { precision: 12, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 12, scale: 2 }).notNull(),

    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
  },
  (table) => [
    uniqueIndex('orders_reference_key').on(table.reference),
    index('orders_user_placed_idx').on(table.userId, table.placedAt.desc()),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  },
  (table) => [index('order_items_order_idx').on(table.orderId)],
);

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    carrier: text('carrier').notNull(),
    trackingNumber: text('tracking_number').notNull(),
    status: shipmentStatusEnum('status').notNull(),

    estimatedDelivery: timestamp('estimated_delivery', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),

    /** Scan history, oldest first. What a tracking page would show. */
    events: jsonb('events')
      .$type<Array<{ at: string; location: string; description: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => [index('shipments_order_idx').on(table.orderId)],
);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),

    number: text('number').notNull(),
    status: invoiceStatusEnum('status').notNull(),
    currency: text('currency').notNull().default('USD'),
    amountDue: numeric('amount_due', { precision: 12, scale: 2 }).notNull(),
    amountPaid: numeric('amount_paid', { precision: 12, scale: 2 }).notNull().default('0'),

    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('invoices_number_key').on(table.number),
    index('invoices_user_issued_idx').on(table.userId, table.issuedAt.desc()),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    status: paymentStatusEnum('status').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('USD'),

    /** Display form only, e.g. "Visa ending 4242". Never a real PAN. */
    method: text('method').notNull(),
    /** Populated on failures — this is what the billing agent explains. */
    failureReason: text('failure_reason'),

    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('payments_invoice_idx').on(table.invoiceId),
    index('payments_user_attempted_idx').on(table.userId, table.attemptedAt.desc()),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),

    reference: text('reference').notNull(),
    status: refundStatusEnum('status').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('USD'),
    reason: text('reason').notNull(),

    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** What to tell the customer about timing while it is in flight. */
    expectedSettlementNote: text('expected_settlement_note'),
  },
  (table) => [
    uniqueIndex('refunds_reference_key').on(table.reference),
    index('refunds_user_requested_idx').on(table.userId, table.requestedAt.desc()),
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    plan: text('plan').notNull(),
    status: subscriptionStatusEnum('status').notNull(),
    currency: text('currency').notNull().default('USD'),
    pricePerPeriod: numeric('price_per_period', { precision: 12, scale: 2 }).notNull(),
    interval: text('interval').notNull().default('month'),

    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  },
  (table) => [index('subscriptions_user_idx').on(table.userId)],
);

export const faqArticles = pgTable(
  'faq_articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topic: text('topic').notNull(),
    question: text('question').notNull(),
    body: text('body').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Ordered remediation steps, for the troubleshooting tool. */
    steps: jsonb('steps').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('faq_topic_idx').on(table.topic)],
);

/**
 * Write-ish actions an agent proposed.
 *
 * Cancelling an order or changing a plan is never executed by the model. The
 * agent records the request here and tells the customer it is queued; a human
 * moves it out of `pending_review`. This keeps a hallucinated tool call from
 * becoming a real refund.
 */
export const actionRequests = pgTable(
  'action_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),

    kind: text('kind').notNull(),
    targetReference: text('target_reference').notNull(),
    status: actionRequestStatusEnum('status').notNull().default('pending_review'),
    detail: text('detail').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [index('action_requests_user_idx').on(table.userId, table.createdAt.desc())],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  conversations: many(conversations),
  orders: many(orders),
  invoices: many(invoices),
  payments: many(payments),
  refunds: many(refunds),
  subscriptions: many(subscriptions),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  run: one(agentRuns, { fields: [messages.id], references: [agentRuns.messageId] }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  message: one(messages, { fields: [agentRuns.messageId], references: [messages.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  items: many(orderItems),
  shipments: many(shipments),
  invoices: many(invoices),
  refunds: many(refunds),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));

export const shipmentsRelations = relations(shipments, ({ one }) => ({
  order: one(orders, { fields: [shipments.orderId], references: [orders.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  user: one(users, { fields: [invoices.userId], references: [users.id] }),
  order: one(orders, { fields: [invoices.orderId], references: [orders.id] }),
  payments: many(payments),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }),
  user: one(users, { fields: [payments.userId], references: [users.id] }),
}));

export const refundsRelations = relations(refunds, ({ one }) => ({
  user: one(users, { fields: [refunds.userId], references: [users.id] }),
  order: one(orders, { fields: [refunds.orderId], references: [orders.id] }),
  payment: one(payments, { fields: [refunds.paymentId], references: [payments.id] }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type ShipmentRow = typeof shipments.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type RefundRow = typeof refunds.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type FaqArticleRow = typeof faqArticles.$inferSelect;
export type ActionRequestRow = typeof actionRequests.$inferSelect;
