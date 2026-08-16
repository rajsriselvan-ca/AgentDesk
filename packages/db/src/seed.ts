import { loadEnvFile } from '@agentdesk/core/load-env';

loadEnvFile();

import { closeDb, getDb } from './client.js';
import {
  actionRequests,
  agentRuns,
  conversations,
  faqArticles,
  invoices,
  messages,
  orderItems,
  orders,
  payments,
  refunds,
  shipments,
  subscriptions,
  users,
} from './schema.js';

/**
 * Seed data.
 *
 * Written to be *interesting* rather than uniform. A seed where every order is
 * "delivered" and every payment succeeded proves nothing: the agents look
 * competent because there is nothing to get wrong. This one includes the cases
 * a support desk actually spends its day on — a parcel stuck in an exception,
 * a card that was declined, a refund still in flight, a subscription that is
 * past due, and an order that is too far along to cancel.
 */

const db = getDb();

const now = Date.now();
const days = (n: number) => new Date(now - n * 86_400_000);
const hours = (n: number) => new Date(now - n * 3_600_000);

async function main(): Promise<void> {
  console.log('Seeding AgentDesk…');

  // Truncate in dependency order. `restart identity cascade` keeps reruns
  // idempotent without dropping and recreating the schema.
  await db.execute(
    `truncate table ${[
      'action_requests',
      'agent_runs',
      'messages',
      'conversations',
      'refunds',
      'payments',
      'invoices',
      'shipments',
      'order_items',
      'orders',
      'subscriptions',
      'faq_articles',
      'users',
    ].join(', ')} restart identity cascade`,
  );

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  const [ada, milo, rosa] = await db
    .insert(users)
    .values([
      { email: 'ada@example.com', name: 'Ada Fontaine', tier: 'premium' },
      { email: 'milo@example.com', name: 'Milo Ferreira', tier: 'standard' },
      { email: 'rosa@example.com', name: 'Rosa Nakamura', tier: 'standard' },
    ])
    .returning();

  if (!ada || !milo || !rosa) throw new Error('User seed failed.');

  // -------------------------------------------------------------------------
  // Orders — one per interesting state
  // -------------------------------------------------------------------------

  const [delivered, inTransit, exception, processing, shipped, cancelled, milosOrder] = await db
    .insert(orders)
    .values([
      {
        userId: ada.id,
        reference: 'AD-10432',
        status: 'delivered',
        subtotal: '289.00',
        shippingCost: '0.00',
        total: '289.00',
        placedAt: days(21),
      },
      {
        userId: ada.id,
        reference: 'AD-10588',
        status: 'shipped',
        subtotal: '64.50',
        shippingCost: '5.50',
        total: '70.00',
        placedAt: days(4),
      },
      {
        // The one customers actually write in about.
        userId: ada.id,
        reference: 'AD-10604',
        status: 'shipped',
        subtotal: '129.99',
        shippingCost: '0.00',
        total: '129.99',
        placedAt: days(9),
      },
      {
        userId: ada.id,
        reference: 'AD-10711',
        status: 'processing',
        subtotal: '45.00',
        shippingCost: '4.99',
        total: '49.99',
        placedAt: hours(20),
      },
      {
        userId: milo.id,
        reference: 'AD-10650',
        status: 'shipped',
        subtotal: '212.00',
        shippingCost: '0.00',
        total: '212.00',
        placedAt: days(3),
      },
      {
        userId: milo.id,
        reference: 'AD-10399',
        status: 'cancelled',
        subtotal: '80.00',
        shippingCost: '0.00',
        total: '80.00',
        placedAt: days(30),
        cancelledAt: days(29),
        cancellationReason: 'Customer changed their mind before dispatch.',
      },
      {
        userId: rosa.id,
        reference: 'AD-10777',
        status: 'confirmed',
        subtotal: '150.00',
        shippingCost: '0.00',
        total: '150.00',
        placedAt: hours(5),
      },
    ])
    .returning();

  if (!delivered || !inTransit || !exception || !processing || !shipped || !cancelled || !milosOrder)
    throw new Error('Order seed failed.');

  await db.insert(orderItems).values([
    { orderId: delivered.id, sku: 'HDPH-01', name: 'Studio Headphones', quantity: 1, unitPrice: '289.00' },
    { orderId: inTransit.id, sku: 'CBL-USB-C', name: 'USB-C Cable, 2m', quantity: 2, unitPrice: '12.25' },
    { orderId: inTransit.id, sku: 'CASE-04', name: 'Hard Carry Case', quantity: 1, unitPrice: '40.00' },
    { orderId: exception.id, sku: 'KYBD-77', name: 'Mechanical Keyboard', quantity: 1, unitPrice: '129.99' },
    { orderId: processing.id, sku: 'MSPD-02', name: 'Desk Mat', quantity: 1, unitPrice: '45.00' },
    { orderId: shipped.id, sku: 'MNTR-27', name: '27-inch Monitor Arm', quantity: 1, unitPrice: '212.00' },
    { orderId: cancelled.id, sku: 'LAMP-03', name: 'Task Lamp', quantity: 1, unitPrice: '80.00' },
    { orderId: milosOrder.id, sku: 'CHR-11', name: 'Ergonomic Chair Cushion', quantity: 1, unitPrice: '150.00' },
  ]);

  await db.insert(shipments).values([
    {
      orderId: delivered.id,
      carrier: 'Northline',
      trackingNumber: 'NL4471820033',
      status: 'delivered',
      estimatedDelivery: days(18),
      deliveredAt: days(18),
      events: [
        { at: days(20).toISOString(), location: 'Leeds DC', description: 'Label created' },
        { at: days(19).toISOString(), location: 'Leeds DC', description: 'Departed facility' },
        { at: days(18).toISOString(), location: 'Manchester', description: 'Delivered, signed for' },
      ],
    },
    {
      orderId: inTransit.id,
      carrier: 'Northline',
      trackingNumber: 'NL4471998210',
      status: 'in_transit',
      estimatedDelivery: days(-2),
      events: [
        { at: days(3).toISOString(), location: 'Leeds DC', description: 'Label created' },
        { at: days(2).toISOString(), location: 'Leeds DC', description: 'Departed facility' },
        { at: days(1).toISOString(), location: 'Birmingham hub', description: 'In transit' },
      ],
    },
    {
      // Stuck. This is the case the order agent has to explain honestly.
      orderId: exception.id,
      carrier: 'Cobalt Freight',
      trackingNumber: 'CF88120477',
      status: 'exception',
      estimatedDelivery: days(3),
      events: [
        { at: days(8).toISOString(), location: 'Leeds DC', description: 'Label created' },
        { at: days(7).toISOString(), location: 'Birmingham hub', description: 'In transit' },
        { at: days(5).toISOString(), location: 'Bristol depot', description: 'Delivery attempted, nobody available' },
        { at: days(4).toISOString(), location: 'Bristol depot', description: 'Held at depot — address could not be verified' },
      ],
    },
    {
      orderId: shipped.id,
      carrier: 'Northline',
      trackingNumber: 'NL4472100845',
      status: 'out_for_delivery',
      estimatedDelivery: hours(-6),
      events: [
        { at: days(2).toISOString(), location: 'Leeds DC', description: 'Label created' },
        { at: hours(9).toISOString(), location: 'Sheffield', description: 'Out for delivery' },
      ],
    },
  ]);

  // -------------------------------------------------------------------------
  // Billing
  // -------------------------------------------------------------------------

  const [paidInvoice, openInvoice, overdueInvoice, refundedInvoice] = await db
    .insert(invoices)
    .values([
      {
        userId: ada.id,
        orderId: delivered.id,
        number: 'INV-2043',
        status: 'paid',
        amountDue: '289.00',
        amountPaid: '289.00',
        issuedAt: days(21),
        dueAt: days(7),
        paidAt: days(21),
      },
      {
        userId: ada.id,
        orderId: exception.id,
        number: 'INV-2088',
        status: 'open',
        amountDue: '129.99',
        amountPaid: '0.00',
        issuedAt: days(9),
        dueAt: days(-5),
      },
      {
        // Failed card → overdue. The billing agent should explain *why*.
        userId: milo.id,
        orderId: shipped.id,
        number: 'INV-2091',
        status: 'overdue',
        amountDue: '212.00',
        amountPaid: '0.00',
        issuedAt: days(3),
        dueAt: days(1),
      },
      {
        userId: milo.id,
        orderId: cancelled.id,
        number: 'INV-1987',
        status: 'refunded',
        amountDue: '80.00',
        amountPaid: '80.00',
        issuedAt: days(30),
        dueAt: days(16),
        paidAt: days(30),
      },
    ])
    .returning();

  if (!paidInvoice || !openInvoice || !overdueInvoice || !refundedInvoice)
    throw new Error('Invoice seed failed.');

  const [, , failedPayment, refundedPayment] = await db
    .insert(payments)
    .values([
      {
        invoiceId: paidInvoice.id,
        userId: ada.id,
        status: 'succeeded',
        amount: '289.00',
        method: 'Visa ending 4242',
        attemptedAt: days(21),
      },
      {
        invoiceId: overdueInvoice.id,
        userId: milo.id,
        status: 'failed',
        amount: '212.00',
        method: 'Mastercard ending 8210',
        failureReason: 'insufficient_funds',
        attemptedAt: days(2),
      },
      {
        invoiceId: overdueInvoice.id,
        userId: milo.id,
        status: 'failed',
        amount: '212.00',
        method: 'Mastercard ending 8210',
        failureReason: 'card_expired',
        attemptedAt: days(1),
      },
      {
        invoiceId: refundedInvoice.id,
        userId: milo.id,
        status: 'refunded',
        amount: '80.00',
        method: 'Visa ending 1881',
        attemptedAt: days(30),
      },
    ])
    .returning();

  if (!failedPayment || !refundedPayment) throw new Error('Payment seed failed.');

  await db.insert(refunds).values([
    {
      // Completed — the easy answer.
      userId: milo.id,
      orderId: cancelled.id,
      paymentId: refundedPayment.id,
      reference: 'RF-5512',
      status: 'completed',
      amount: '80.00',
      reason: 'Order cancelled before dispatch.',
      requestedAt: days(29),
      settledAt: days(24),
    },
    {
      // Still in flight — the answer that needs a timing expectation set.
      userId: ada.id,
      orderId: delivered.id,
      reference: 'RF-5619',
      status: 'processing',
      amount: '289.00',
      reason: 'Returned — headphones had a rattling left cup.',
      requestedAt: days(6),
      expectedSettlementNote:
        'Sent to the card issuer on day 3. Issuers typically post the credit 5–10 business days after that.',
    },
  ]);

  await db.insert(subscriptions).values([
    {
      userId: ada.id,
      plan: 'AgentDesk Plus',
      status: 'active',
      pricePerPeriod: '12.00',
      currentPeriodStart: days(12),
      currentPeriodEnd: days(-18),
    },
    {
      userId: milo.id,
      plan: 'AgentDesk Plus',
      status: 'past_due',
      pricePerPeriod: '12.00',
      currentPeriodStart: days(20),
      currentPeriodEnd: days(-10),
      cancelAtPeriodEnd: true,
    },
  ]);

  // -------------------------------------------------------------------------
  // Knowledge base
  // -------------------------------------------------------------------------

  await db.insert(faqArticles).values([
    {
      topic: 'delivery',
      question: 'How long does delivery take?',
      body: 'Standard delivery is 3–5 working days. Express is next working day when ordered before 3pm. Remote postcodes add one day.',
      tags: ['shipping', 'delivery', 'timing'],
      steps: [],
    },
    {
      topic: 'delivery',
      question: 'My tracking has not updated in several days. What should I do?',
      body: 'Tracking can stall while a parcel moves between hubs. If there has been no scan for 3 working days, or the status shows an exception, the depot is holding it and needs an instruction from us.',
      tags: ['tracking', 'stuck', 'exception', 'delayed'],
      steps: [
        'Check the latest scan and its location.',
        'If the status is an exception, confirm the delivery address on the order.',
        'Ask the carrier to re-attempt with the confirmed address, or redirect to a pickup point.',
        'If there is still no movement after 2 working days, raise a lost-parcel claim and offer a replacement.',
      ],
    },
    {
      topic: 'returns',
      question: 'What is the returns window?',
      body: 'Returns are accepted within 30 days of delivery, unopened or faulty. Faulty items are collected free of charge.',
      tags: ['returns', 'refund', 'policy'],
      steps: [],
    },
    {
      topic: 'refunds',
      question: 'When will my refund arrive?',
      body: 'Refunds are approved within 2 working days of the return arriving. Once sent to your card issuer, the credit typically posts 5–10 business days later. That last step is controlled by the bank, not by us.',
      tags: ['refund', 'timing', 'money back'],
      steps: [],
    },
    {
      topic: 'billing',
      question: 'Why was my card declined?',
      body: 'The most common causes are insufficient funds, an expired card, or a bank fraud check on a larger-than-usual amount. The decline reason from the issuer is recorded against each attempt.',
      tags: ['payment', 'declined', 'card', 'failed'],
      steps: [
        'Check the recorded decline reason on the most recent attempt.',
        'If the card expired, ask the customer to update their payment method.',
        'If funds were insufficient, offer to retry on a chosen date.',
        'If the issuer blocked it, ask the customer to approve the charge with their bank, then retry.',
      ],
    },
    {
      topic: 'account',
      question: 'How do I change my subscription plan?',
      body: 'Plan changes take effect at the start of the next billing period. Downgrades keep the current plan until the period ends; upgrades are prorated immediately.',
      tags: ['subscription', 'plan', 'upgrade', 'downgrade'],
      steps: [],
    },
    {
      topic: 'troubleshooting',
      question: 'My headphones crackle on one side.',
      body: 'Crackling isolated to one channel is usually a cable or connector fault rather than the driver.',
      tags: ['headphones', 'audio', 'crackling', 'faulty', 'rattling'],
      steps: [
        'Try a different cable, if the model has a detachable one.',
        'Test on a second device to rule out the source.',
        'Check the connector for lint and clean it gently.',
        'If the fault follows the headphones, it is a hardware fault — arrange a free collection under warranty.',
      ],
    },
  ]);

  // -------------------------------------------------------------------------
  // Prior conversations
  //
  // These exist so the support agent's history tool has something real to
  // recall, and so one conversation is long enough to trigger compaction.
  // -------------------------------------------------------------------------

  const [pastDelivery, pastBilling] = await db
    .insert(conversations)
    .values([
      { userId: ada.id, title: 'Headphones arrived with a rattle', createdAt: days(7), updatedAt: days(6) },
      { userId: milo.id, title: 'Card keeps getting declined', createdAt: days(2), updatedAt: days(2) },
    ])
    .returning();

  if (!pastDelivery || !pastBilling) throw new Error('Conversation seed failed.');

  await db.insert(messages).values([
    {
      conversationId: pastDelivery.id,
      role: 'user',
      content: 'The headphones from order AD-10432 have a rattle in the left cup. Can I send them back?',
      createdAt: days(7),
    },
    {
      conversationId: pastDelivery.id,
      role: 'assistant',
      agent: 'support',
      content:
        'Sorry about that — a rattle in one cup is a hardware fault, so it is covered. Order AD-10432 was delivered 18 days ago, well inside the 30-day window, and faulty items are collected free of charge. I have started a return for you.',
      createdAt: days(7),
    },
    {
      conversationId: pastDelivery.id,
      role: 'user',
      content: 'Great, thanks. How long until I get the money back?',
      createdAt: days(6),
    },
    {
      conversationId: pastDelivery.id,
      role: 'assistant',
      agent: 'billing',
      content:
        'Refund RF-5619 for $289.00 is processing. It was approved once the return arrived and has been sent to your card issuer — they usually post the credit 5–10 business days after that.',
      createdAt: days(6),
    },
    {
      conversationId: pastBilling.id,
      role: 'user',
      content: 'My payment for the monitor arm failed twice. What is going on?',
      createdAt: days(2),
    },
    {
      conversationId: pastBilling.id,
      role: 'assistant',
      agent: 'billing',
      content:
        'Invoice INV-2091 has two failed attempts on the Mastercard ending 8210 — the first was declined for insufficient funds, the second because the card has expired. Updating the card on file and retrying should clear it.',
      createdAt: days(2),
    },
  ]);

  await db.insert(actionRequests).values([
    {
      userId: ada.id,
      conversationId: pastDelivery.id,
      kind: 'return_collection',
      targetReference: 'AD-10432',
      status: 'approved',
      detail: 'Free warranty collection booked for faulty headphones.',
      createdAt: days(7),
      resolvedAt: days(7),
    },
  ]);

  const counts = await Promise.all(
    ['users', 'orders', 'shipments', 'invoices', 'payments', 'refunds', 'faq_articles', 'messages'].map(
      async (table) => {
        const result = await db.execute(`select count(*)::int as n from ${table}`);
        const row = (result as unknown as Array<{ n: number }>)[0];
        return `${table}=${row?.n ?? 0}`;
      },
    ),
  );

  console.log(`Seeded: ${counts.join('  ')}`);
  console.log(`\nDemo users (use the picker in the UI, or the x-user-id header):`);
  console.log(`  ${ada.id}  Ada Fontaine   premium  — stuck parcel, refund in flight`);
  console.log(`  ${milo.id}  Milo Ferreira  standard — declined card, past-due plan`);
  console.log(`  ${rosa.id}  Rosa Nakamura  standard — brand new, almost no history`);

  await closeDb();
}

main().catch(async (error: unknown) => {
  console.error('Seed failed.');
  console.error(error);
  await closeDb().catch(() => {});
  process.exit(1);
});
