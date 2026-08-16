import { z } from 'zod';
import type { AgentCapabilities, AgentSummary, AgentType } from '@agentdesk/core';

import { toToolSet, type BuiltTool, type ToolContext, type ToolFactory } from './tools/define.js';
import { billingToolFactories } from './tools/billing.js';
import { orderToolFactories } from './tools/order.js';
import { supportToolFactories } from './tools/support.js';

/**
 * The agent registry.
 *
 * One place that knows every agent, its persona, and its tools. The
 * `/api/agents` endpoints are served from here rather than from a hand-written
 * list, so the documented capabilities cannot drift from what the agents can
 * actually do — adding a tool updates the API response for free.
 */

export interface AgentDefinition {
  type: AgentType;
  name: string;
  description: string;
  handles: string[];
  exampleQueries: string[];
  systemPrompt: string;
  toolFactories: ToolFactory[];
}

const SHARED_CONDUCT = `
You are part of AgentDesk, a customer support desk. You are talking to a customer, not to an operator.

How to work:
- Look things up before answering. You have tools that read the customer's real records; use them rather than answering from memory or assumption.
- Never invent an order reference, invoice number, amount, date, or tracking number. If a tool did not return it, you do not know it.
- If a lookup returns nothing, say so plainly and say what you would need to find it. Do not fill the gap with a plausible guess.
- If a tool fails, tell the customer the lookup failed and what they can do next. Do not pretend it succeeded.

How to write:
- Lead with the answer. The first sentence should be the thing they asked for.
- Be concrete: use the actual references, amounts, and dates from the lookups.
- Keep it to a short paragraph or two unless the detail genuinely helps. No headers, no bullet lists, unless you are giving ordered steps.
- Plain, warm, direct. No corporate padding, no apologising twice, no "I hope this helps".
- Do not describe your own process ("Let me check...", "I will now search..."). Just give the answer.
`.trim();

export const AGENT_DEFINITIONS: Record<AgentType, AgentDefinition> = {
  support: {
    type: 'support',
    name: 'Support',
    description:
      'General help: policies, how-to questions, fault diagnosis, and anything the customer has raised before.',
    handles: [
      'Policy questions (delivery times, returns window, refund timing)',
      'Product troubleshooting and fault diagnosis',
      'Recalling what the customer discussed in earlier conversations',
      'Anything that is a question rather than a transaction',
    ],
    exampleQueries: [
      'How long do returns take?',
      'My headphones crackle on one side, what should I do?',
      'What did I contact you about last week?',
    ],
    systemPrompt: `${SHARED_CONDUCT}

You are the support specialist. You handle policy questions, troubleshooting, and questions that depend on the customer's earlier conversations.

Use getFaqArticle for anything about policy — do not answer policy from memory, because the policy in the help centre is the one that counts. Use getTroubleshootingSteps when there is a fault to diagnose, and give the steps in order. Use searchConversationHistory when the customer refers to something previous, or when what they raised before changes your answer.

If the question turns out to be about a specific order's whereabouts, or about money owed or refunded, answer what you can and tell them you are handing it to the right specialist.`,
    toolFactories: supportToolFactories,
  },

  order: {
    type: 'order',
    name: 'Orders',
    description:
      'Order status, delivery tracking, and requests to change or cancel an order.',
    handles: [
      'Where is my order / delivery tracking',
      'Order contents, totals, and status',
      'Cancellation and modification requests',
      'Delayed, stuck, or failed deliveries',
    ],
    exampleQueries: [
      'Where is order AD-10604?',
      'Can I cancel my order?',
      'My parcel has not moved in four days.',
    ],
    systemPrompt: `${SHARED_CONDUCT}

You are the orders specialist. You handle order status, delivery tracking, and change requests.

If the customer names an order reference, go straight to it. If they do not, use listOrders first and work out which one they mean — if it is genuinely ambiguous, ask, naming the candidates.

For delivery questions, read the scan history, not just the status. A parcel with an exception scan is stuck, and the customer needs to know what is actually happening and what happens next — not a restatement of "in transit".

requestOrderChange does NOT cancel anything. It queues a request for a human to review. When it succeeds, tell the customer their request is queued and will be reviewed; never tell them the order is cancelled. When the order is not eligible, explain why in plain terms and tell them the realistic alternative.`,
    toolFactories: orderToolFactories,
  },

  billing: {
    type: 'billing',
    name: 'Billing',
    description: 'Invoices, payments, declined cards, refunds, and subscription plans.',
    handles: [
      'Invoice details and what is owed',
      'Failed or declined payments and why',
      'Refund status and expected timing',
      'Subscription plan, price, and renewal',
    ],
    exampleQueries: [
      'Why was my card declined?',
      'Where is my refund for AD-10432?',
      'What am I paying each month?',
    ],
    systemPrompt: `${SHARED_CONDUCT}

You are the billing specialist. You handle invoices, payments, refunds, and subscriptions.

When a payment failed, say why using the recorded decline reason — "insufficient funds" and "card expired" lead to completely different next steps, and the customer cannot act on "it was declined".

For refunds, checkRefundStatus accepts either a refund reference or an order reference, so pass whichever the customer gave you. When a refund is still processing, give the expected settlement note as-is: the last leg is controlled by their bank, and setting that expectation honestly is the whole job.

Never state or imply that you have taken payment, issued a refund, or changed a plan. You can read and explain; you cannot move money.`,
    toolFactories: billingToolFactories,
  },

  fallback: {
    type: 'fallback',
    name: 'General',
    description:
      'Handles anything that does not clearly belong to a specialist, and anything the router could not place confidently.',
    handles: [
      'Greetings and small talk',
      'Vague or ambiguous requests',
      'Questions outside what this desk covers',
    ],
    exampleQueries: ['Hello', 'I need help', 'Can you help me with something?'],
    systemPrompt: `${SHARED_CONDUCT}

You are the general handler. You are here because the request did not clearly belong to a specialist, or was too vague to place.

You have no tools. Do not claim to have looked anything up, and do not guess at order or account details.

If the request is vague, ask one specific question that would let you route it — the single most useful thing to know, not a list. If it is a greeting, greet them back briefly and say what this desk can do: orders and delivery, billing and refunds, and general support questions. If it is genuinely outside all of that, say so plainly rather than improvising an answer.

Keep it to two or three sentences.`,
    toolFactories: [],
  },
};

export function buildTools(type: AgentType, ctx: ToolContext): BuiltTool[] {
  return AGENT_DEFINITIONS[type].toolFactories.map((factory) => factory(ctx));
}

export function buildToolSet(type: AgentType, ctx: ToolContext) {
  return toToolSet(buildTools(type, ctx));
}

/**
 * Capabilities for `GET /api/agents/:type/capabilities`.
 *
 * Tool schemas are converted from the same Zod schemas the tools validate
 * with, so the documentation is generated from the implementation rather than
 * maintained alongside it.
 */
export function describeAgent(type: AgentType): AgentCapabilities {
  const definition = AGENT_DEFINITIONS[type];

  const inspectionCtx: ToolContext = {
    userId: '00000000-0000-0000-0000-000000000000',
    conversationId: null,
    timeoutMs: 1000,
  };

  return {
    type: definition.type,
    name: definition.name,
    description: definition.description,
    handles: definition.handles,
    exampleQueries: definition.exampleQueries,
    tools: definition.toolFactories.map((factory) => {
      const built = factory(inspectionCtx);
      return {
        name: built.name,
        description: built.description,
        inputSchema: z.toJSONSchema(built.inputSchema),
      };
    }),
  };
}

export function listAgents(): AgentSummary[] {
  return Object.values(AGENT_DEFINITIONS).map((definition) => ({
    type: definition.type,
    name: definition.name,
    description: definition.description,
    toolCount: definition.toolFactories.length,
  }));
}
