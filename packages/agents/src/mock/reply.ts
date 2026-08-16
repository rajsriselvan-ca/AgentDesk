import type { AgentType } from '@agentdesk/core';
import type { ObservedToolResult } from './prompt-utils.js';

/**
 * Turn tool output into an answer.
 *
 * The mock's replies are templates, but they are templates over *real rows* —
 * the tool ran against Postgres and this renders what came back. So a stuck
 * parcel reads as a stuck parcel with its actual last scan, and a declined
 * card names the actual decline reason. The point is that a reviewer can see
 * the data flowing end to end without a model in the loop.
 */

function money(amount: string, currency: string): string {
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  return `${symbol}${amount}`;
}

function date(iso: string | null): string {
  if (!iso) return 'an unknown date';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function readable(status: string): string {
  return status.replace(/_/g, ' ');
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;

export function renderReply(
  agent: AgentType,
  userText: string,
  results: ObservedToolResult[],
): string {
  if (agent === 'fallback' || results.length === 0) {
    return renderWithoutTools(agent, userText);
  }

  const rendered = results.map((result) => renderToolResult(result)).filter(Boolean);

  if (rendered.length === 0) {
    return "I could not find anything matching that. If you can give me the reference — an order like AD-10432, or an invoice like INV-2091 — I will pull it up.";
  }

  return rendered.join('\n\n');
}

function renderWithoutTools(agent: AgentType, userText: string): string {
  const text = userText.toLowerCase().trim();

  if (/^(hi|hey|hello|good (morning|afternoon|evening))/.test(text)) {
    return 'Hello. I can help with orders and delivery, billing and refunds, or general support questions. What do you need?';
  }

  if (/thank/.test(text)) {
    return 'Glad to help. Anything else you need?';
  }

  if (agent === 'fallback') {
    return "I want to point you at the right person, but I need a bit more to go on. Is this about an order or a delivery, something on your bill or a refund, or a problem with a product?";
  }

  return "I could not find anything to work from there. Give me the reference — an order like AD-10432, or an invoice like INV-2091 — and I will look it up.";
}

function renderToolResult({ toolName, output }: ObservedToolResult): string {
  if (!isRow(output) && !Array.isArray(output)) return '';

  if (isRow(output) && 'error' in output) {
    return `That lookup did not come back: ${String(output.error)}. Try again in a moment, and if it keeps failing I will pass this to a colleague.`;
  }

  switch (toolName) {
    case 'listOrders':
      return renderOrderList(output);
    case 'getOrderDetails':
      return renderOrderDetail(output);
    case 'checkDeliveryStatus':
      return renderDelivery(output);
    case 'requestOrderChange':
      return renderChangeRequest(output);
    case 'listInvoices':
      return renderInvoiceList(output);
    case 'getInvoice':
      return renderInvoice(output);
    case 'listPayments':
      return renderPayments(output);
    case 'checkRefundStatus':
      return renderRefunds(output);
    case 'getSubscription':
      return renderSubscription(output);
    case 'searchConversationHistory':
      return renderHistory(output);
    case 'getFaqArticle':
      return renderFaq(output);
    case 'getTroubleshootingSteps':
      return renderTroubleshooting(output);
    default:
      return '';
  }
}

function renderOrderList(output: unknown): string {
  if (!Array.isArray(output) || output.length === 0) {
    return 'I cannot see any orders on your account. If you ordered as a guest, the confirmation email will have the reference.';
  }

  const lines = output
    .filter(isRow)
    .map(
      (order) =>
        `${String(order.reference)} — ${readable(String(order.status))}, placed ${date(String(order.placedAt))}, ${money(String(order.total), String(order.currency))}`,
    );

  return `Here are your most recent orders:\n\n${lines.join('\n')}\n\nWhich one did you mean?`;
}

function renderOrderDetail(output: unknown): string {
  if (!isRow(output)) return '';
  if ('notFound' in output) {
    return `I cannot find an order ${String(output.orderReference)} on your account. Double-check the reference — it will be on your confirmation email, in the form AD-10432.`;
  }

  const items = Array.isArray(output.items) ? output.items.filter(isRow) : [];
  const itemLines = items
    .map((item) => `${String(item.quantity)} × ${String(item.name)} (${String(item.sku)})`)
    .join(', ');

  const cancelled =
    output.cancelledAt !== null
      ? ` It was cancelled on ${date(String(output.cancelledAt))}: ${String(output.cancellationReason ?? 'no reason recorded')}.`
      : '';

  return `Order ${String(output.reference)} is ${readable(String(output.status))}. It was placed on ${date(String(output.placedAt))} for ${money(String(output.total), String(output.currency))} and contains ${itemLines || 'no line items'}.${cancelled}`;
}

function renderDelivery(output: unknown): string {
  if (!isRow(output)) return '';
  if ('notFound' in output) {
    return `I cannot find an order ${String(output.orderReference)} on your account. Check the reference on your confirmation email.`;
  }

  const events = Array.isArray(output.events) ? output.events.filter(isRow) : [];
  const latest = events.at(-1);

  if (!output.shipmentStatus) {
    return `Order ${String(output.orderReference)} is ${readable(String(output.orderStatus))} and has not been handed to a carrier yet, so there is no tracking to follow. You will get an email with the tracking number the moment it ships.`;
  }

  const status = String(output.shipmentStatus);
  const header = `Order ${String(output.orderReference)} is with ${String(output.carrier)} on tracking ${String(output.trackingNumber)}, currently ${readable(status)}.`;

  const lastScan = latest
    ? ` The last scan was ${date(String(latest.at))} at ${String(latest.location)}: ${String(latest.description)}.`
    : '';

  if (status === 'exception') {
    return `${header}${lastScan}\n\nThat means it is being held rather than moving — the depot needs an instruction before it will go out again. I can ask them to re-attempt with a confirmed address, or redirect it to a pickup point. Which would you prefer?`;
  }

  if (status === 'delivered') {
    return `${header}${lastScan} It was delivered on ${date(String(output.deliveredAt))}.`;
  }

  const eta = output.estimatedDelivery
    ? ` It is estimated to arrive ${date(String(output.estimatedDelivery))}.`
    : '';

  return `${header}${lastScan}${eta}`;
}

function renderChangeRequest(output: unknown): string {
  if (!isRow(output)) return '';
  if ('notFound' in output) {
    return `I cannot find order ${String(output.orderReference)} on your account, so there is nothing for me to queue.`;
  }

  if (output.submitted === false) {
    return `I cannot change order ${String(output.orderReference)} — it is ${readable(String(output.orderStatus))}. ${String(output.reason)} If you want to send it back once it arrives, I can start a return instead.`;
  }

  return `I have queued the request against order ${String(output.orderReference)} and it is with the team for review — it is not cancelled yet, and you will get an email once someone has actioned it. ${String(output.note ?? '')}`.trim();
}

function renderInvoiceList(output: unknown): string {
  if (!Array.isArray(output) || output.length === 0) {
    return 'There are no invoices on your account at the moment.';
  }

  const lines = output
    .filter(isRow)
    .map(
      (invoice) =>
        `${String(invoice.number)} — ${readable(String(invoice.status))}, ${money(String(invoice.amountDue), String(invoice.currency))}, due ${date(String(invoice.dueAt))}`,
    );

  return `Here are your recent invoices:\n\n${lines.join('\n')}`;
}

function renderInvoice(output: unknown): string {
  if (!isRow(output)) return '';
  if ('notFound' in output) {
    return `I cannot find invoice ${String(output.invoiceNumber)} on your account.`;
  }

  const attempts = Array.isArray(output.payments) ? output.payments.filter(isRow) : [];
  const failed = attempts.filter((attempt) => attempt.status === 'failed');

  const base = `Invoice ${String(output.number)} is ${readable(String(output.status))} — ${money(String(output.amountDue), String(output.currency))}, issued ${date(String(output.issuedAt))} and due ${date(String(output.dueAt))}.`;

  if (failed.length === 0) return base;

  const reasons = failed
    .map((attempt) => `${String(attempt.method)} on ${date(String(attempt.attemptedAt))} (${readable(String(attempt.failureReason ?? 'declined'))})`)
    .join(', and ');

  return `${base}\n\nThere have been ${failed.length} failed attempt(s): ${reasons}. Updating the card on file and retrying should clear it.`;
}

function renderPayments(output: unknown): string {
  if (!Array.isArray(output) || output.length === 0) {
    return 'I cannot see any payment attempts on your account.';
  }

  const rows = output.filter(isRow);
  const failed = rows.filter((payment) => payment.status === 'failed');

  if (failed.length === 0) {
    const latest = rows[0];
    return `Your payments have all gone through. The most recent was ${money(String(latest?.amount), String(latest?.currency))} on ${String(latest?.method)}, ${date(String(latest?.attemptedAt))}.`;
  }

  const lines = failed.map(
    (payment) =>
      `${date(String(payment.attemptedAt))} — ${money(String(payment.amount), String(payment.currency))} on ${String(payment.method)}, declined: ${readable(String(payment.failureReason ?? 'unknown reason'))} (invoice ${String(payment.invoiceNumber)})`,
  );

  const guidance = failed.some((payment) => payment.failureReason === 'card_expired')
    ? 'The card on file has expired, so the retry will keep failing until it is replaced. Once you update it I can have the payment retried.'
    : 'Your bank declined it rather than us. Once there are funds available, the payment can be retried.';

  return `There ${failed.length === 1 ? 'is 1 failed payment' : `are ${failed.length} failed payments`} on your account:\n\n${lines.join('\n')}\n\n${guidance}`;
}

function renderRefunds(output: unknown): string {
  if (!isRow(output)) return '';

  const refunds = Array.isArray(output.refunds) ? output.refunds.filter(isRow) : [];

  if (refunds.length === 0) {
    const others = Array.isArray(output.otherRefunds) ? output.otherRefunds.filter(isRow) : [];
    if (others.length === 0) {
      return `I cannot find a refund for ${String(output.notFoundFor ?? 'that reference')}, and there are no refunds on your account at all. If you have sent something back recently, it may not have been booked in yet.`;
    }

    const lines = others.map(
      (refund) =>
        `${String(refund.reference)} — ${readable(String(refund.status))}, ${money(String(refund.amount), String(refund.currency))}${refund.orderReference ? ` for order ${String(refund.orderReference)}` : ''}`,
    );

    return `I cannot find a refund matching ${String(output.notFoundFor ?? 'that')}, but you do have these:\n\n${lines.join('\n')}`;
  }

  return refunds
    .map((refund) => {
      const header = `Refund ${String(refund.reference)} for ${money(String(refund.amount), String(refund.currency))}${refund.orderReference ? ` on order ${String(refund.orderReference)}` : ''} is ${readable(String(refund.status))}.`;

      if (refund.status === 'completed') {
        return `${header} It settled on ${date(String(refund.settledAt))}, so it should already be on your statement.`;
      }

      const note = refund.expectedSettlementNote
        ? ` ${String(refund.expectedSettlementNote)}`
        : ' Once it reaches your card issuer they typically post the credit within 5–10 business days.';

      return `${header} It was requested on ${date(String(refund.requestedAt))}.${note}`;
    })
    .join('\n\n');
}

function renderSubscription(output: unknown): string {
  if (!isRow(output)) return '';
  if ('notFound' in output) {
    return 'There is no subscription on your account — everything you have bought has been a one-off order.';
  }

  const base = `You are on ${String(output.plan)} at ${money(String(output.pricePerPeriod), String(output.currency))} per ${String(output.interval)}. The current period runs to ${date(String(output.currentPeriodEnd))}.`;

  if (output.status === 'past_due') {
    return `${base}\n\nIt is currently past due, which means the last renewal payment did not go through. The plan stays active for now, but it will lapse if the payment is not settled.`;
  }

  if (output.cancelAtPeriodEnd === true) {
    return `${base}\n\nIt is set to cancel at the end of that period, so it will not renew.`;
  }

  return `${base} It renews automatically.`;
}

function renderHistory(output: unknown): string {
  if (!Array.isArray(output) || output.length === 0) {
    return 'I cannot find anything about that in your previous conversations with us.';
  }

  const rows = output.filter(isRow).slice(0, 3);
  const lines = rows.map(
    (match) =>
      `${date(String(match.createdAt))} — in "${String(match.conversationTitle)}": ${String(match.content).slice(0, 180)}`,
  );

  return `Yes, this has come up before:\n\n${lines.join('\n\n')}`;
}

function renderFaq(output: unknown): string {
  if (!isRow(output)) return '';

  const articles = Array.isArray(output.articles) ? output.articles.filter(isRow) : [];

  if (articles.length === 0) {
    const topics = Array.isArray(output.availableTopics) ? output.availableTopics : [];
    return topics.length > 0
      ? `I do not have an article on that. The topics I can cover are: ${topics.join(', ')}.`
      : 'I do not have an article covering that.';
  }

  const first = articles[0];
  if (!first) return '';

  return String(first.body);
}

function renderTroubleshooting(output: unknown): string {
  if (!isRow(output)) return '';

  const articles = Array.isArray(output.articles) ? output.articles.filter(isRow) : [];
  const first = articles[0];

  if (!first) {
    return 'I do not have a troubleshooting guide for that specific symptom. Describe what happens and when, and I will pass it to someone who can dig into it.';
  }

  const steps = Array.isArray(first.steps) ? first.steps.map(String) : [];
  const numbered = steps.map((step, index) => `${index + 1}. ${step}`).join('\n');

  return `${String(first.body)}\n\n${numbered}`;
}
