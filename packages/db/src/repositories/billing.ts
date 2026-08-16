import { and, desc, eq, gte, lte, or, sql } from 'drizzle-orm';

import { db } from '../client.js';
import { invoices, orders, payments, refunds, subscriptions } from '../schema.js';

/** Billing reads for the billing agent's tools. All scoped by userId. */

export interface InvoiceDetail {
  number: string;
  status: string;
  currency: string;
  amountDue: string;
  amountPaid: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  orderReference: string | null;
  payments: Array<{
    status: string;
    amount: string;
    method: string;
    failureReason: string | null;
    attemptedAt: string;
  }>;
}

export async function getInvoice(
  userId: string,
  invoiceRef: string,
): Promise<InvoiceDetail | null> {
  const [invoice] = await db
    .select({ invoice: invoices, orderReference: orders.reference })
    .from(invoices)
    .leftJoin(orders, eq(orders.id, invoices.orderId))
    .where(
      and(
        eq(invoices.userId, userId),
        or(
          sql`upper(${invoices.number}) = upper(${invoiceRef.trim()})`,
          sql`${invoices.id}::text = ${invoiceRef.trim()}`,
        ),
      ),
    )
    .limit(1);

  if (!invoice) return null;

  const attempts = await db
    .select({
      status: payments.status,
      amount: payments.amount,
      method: payments.method,
      failureReason: payments.failureReason,
      attemptedAt: payments.attemptedAt,
    })
    .from(payments)
    .where(eq(payments.invoiceId, invoice.invoice.id))
    .orderBy(desc(payments.attemptedAt));

  return {
    number: invoice.invoice.number,
    status: invoice.invoice.status,
    currency: invoice.invoice.currency,
    amountDue: invoice.invoice.amountDue,
    amountPaid: invoice.invoice.amountPaid,
    issuedAt: invoice.invoice.issuedAt.toISOString(),
    dueAt: invoice.invoice.dueAt.toISOString(),
    paidAt: invoice.invoice.paidAt?.toISOString() ?? null,
    orderReference: invoice.orderReference,
    payments: attempts.map((attempt) => ({
      ...attempt,
      attemptedAt: attempt.attemptedAt.toISOString(),
    })),
  };
}

export interface InvoiceSummary {
  number: string;
  status: string;
  amountDue: string;
  currency: string;
  issuedAt: string;
  dueAt: string;
}

export async function listInvoices(
  userId: string,
  options: { status?: string | undefined; limit: number },
): Promise<InvoiceSummary[]> {
  const rows = await db
    .select({
      number: invoices.number,
      status: invoices.status,
      amountDue: invoices.amountDue,
      currency: invoices.currency,
      issuedAt: invoices.issuedAt,
      dueAt: invoices.dueAt,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.userId, userId),
        options.status ? sql`${invoices.status}::text = ${options.status}` : undefined,
      ),
    )
    .orderBy(desc(invoices.issuedAt))
    .limit(options.limit);

  return rows.map((row) => ({
    ...row,
    issuedAt: row.issuedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
  }));
}

export interface PaymentSummary {
  status: string;
  amount: string;
  currency: string;
  method: string;
  failureReason: string | null;
  attemptedAt: string;
  invoiceNumber: string;
}

export async function listPayments(
  userId: string,
  options: { since?: string | undefined; limit: number },
): Promise<PaymentSummary[]> {
  const sinceDate = options.since ? new Date(options.since) : null;
  const validSince = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null;

  const rows = await db
    .select({
      status: payments.status,
      amount: payments.amount,
      currency: payments.currency,
      method: payments.method,
      failureReason: payments.failureReason,
      attemptedAt: payments.attemptedAt,
      invoiceNumber: invoices.number,
    })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(
      and(
        eq(payments.userId, userId),
        validSince ? gte(payments.attemptedAt, validSince) : undefined,
      ),
    )
    .orderBy(desc(payments.attemptedAt))
    .limit(options.limit);

  return rows.map((row) => ({ ...row, attemptedAt: row.attemptedAt.toISOString() }));
}

export interface RefundStatus {
  reference: string;
  status: string;
  amount: string;
  currency: string;
  reason: string;
  requestedAt: string;
  settledAt: string | null;
  expectedSettlementNote: string | null;
  orderReference: string | null;
}

/**
 * Look up refunds by refund reference *or* by the order they belong to.
 *
 * Customers almost never know their refund reference — they know the order
 * they returned. Accepting both is the difference between a useful tool and
 * one that always answers "not found".
 */
export async function findRefunds(
  userId: string,
  reference: string,
): Promise<RefundStatus[]> {
  const trimmed = reference.trim();

  const rows = await db
    .select({ refund: refunds, orderReference: orders.reference })
    .from(refunds)
    .leftJoin(orders, eq(orders.id, refunds.orderId))
    .where(
      and(
        eq(refunds.userId, userId),
        or(
          sql`upper(${refunds.reference}) = upper(${trimmed})`,
          sql`upper(${orders.reference}) = upper(${trimmed})`,
          sql`${refunds.id}::text = ${trimmed}`,
        ),
      ),
    )
    .orderBy(desc(refunds.requestedAt));

  return rows.map(({ refund, orderReference }) => ({
    reference: refund.reference,
    status: refund.status,
    amount: refund.amount,
    currency: refund.currency,
    reason: refund.reason,
    requestedAt: refund.requestedAt.toISOString(),
    settledAt: refund.settledAt?.toISOString() ?? null,
    expectedSettlementNote: refund.expectedSettlementNote,
    orderReference,
  }));
}

export async function listRefunds(userId: string, limit: number): Promise<RefundStatus[]> {
  const rows = await db
    .select({ refund: refunds, orderReference: orders.reference })
    .from(refunds)
    .leftJoin(orders, eq(orders.id, refunds.orderId))
    .where(eq(refunds.userId, userId))
    .orderBy(desc(refunds.requestedAt))
    .limit(limit);

  return rows.map(({ refund, orderReference }) => ({
    reference: refund.reference,
    status: refund.status,
    amount: refund.amount,
    currency: refund.currency,
    reason: refund.reason,
    requestedAt: refund.requestedAt.toISOString(),
    settledAt: refund.settledAt?.toISOString() ?? null,
    expectedSettlementNote: refund.expectedSettlementNote,
    orderReference,
  }));
}

export interface SubscriptionDetail {
  plan: string;
  status: string;
  currency: string;
  pricePerPeriod: string;
  interval: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

export async function getSubscription(userId: string): Promise<SubscriptionDetail | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  if (!row) return null;

  return {
    plan: row.plan,
    status: row.status,
    currency: row.currency,
    pricePerPeriod: row.pricePerPeriod,
    interval: row.interval,
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}
