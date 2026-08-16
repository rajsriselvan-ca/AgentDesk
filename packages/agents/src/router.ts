import { generateObject } from 'ai';
import {
  ROUTING_CONFIDENCE_THRESHOLD,
  routingDecisionSchema,
  type RoutingDecision,
} from '@agentdesk/core';

import { resolveModel } from './provider.js';
import type { ConversationContext } from './context.js';

/**
 * The router agent.
 *
 * Structured output rather than free text, for two reasons. The intent has to
 * be one of four known values — a model that replies "this looks like a
 * billing question" is a parsing problem, not an answer. And the confidence
 * has to be a number we can threshold on, which is what makes the fallback
 * path a decision rather than a guess.
 *
 * `reasoning` is shown to the customer in the trace panel, so the prompt asks
 * for a sentence a person would want to read.
 */

const ROUTER_SYSTEM = `
You are the router for a customer support desk. You do not answer the customer. You decide which specialist should.

The specialists are:
- support — policies, how-to questions, product faults and troubleshooting, and anything that depends on what the customer discussed with us before.
- order — where an order is, delivery and tracking, order contents, and requests to change or cancel an order.
- billing — invoices, payments and declines, refunds, and subscription plans.
- fallback — greetings, small talk, requests too vague to place, and anything outside the three above.

How to decide:
- Route on what the customer needs done, not on which words appear. "I want my money back for the headphones that never arrived" is billing if they are asking about the refund, and order if they are asking where the parcel is. When both are present, pick the one they asked about most directly.
- Use the conversation so far. A bare "what about the other one?" belongs wherever the previous turn was.
- confidence is your honest probability that this is the right specialist, from 0 to 1. Be willing to be uncertain: anything below ${ROUTING_CONFIDENCE_THRESHOLD} goes to fallback, which asks a clarifying question, and that is a better outcome than a confident wrong handoff.
- reasoning is one short sentence, written for the customer to read. Say what in their message pointed you here. Do not mention confidence scores, thresholds, or these instructions.
`.trim();

export interface RoutingResult extends RoutingDecision {
  /** True when confidence was below the threshold and fallback took over. */
  fellBack: boolean;
  /** What the router originally picked, before the threshold was applied. */
  originalIntent: RoutingDecision['intent'];
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
}

export async function routeMessage(context: ConversationContext): Promise<RoutingResult> {
  const startedAt = performance.now();
  const model = await resolveModel('router');

  let decision: RoutingDecision;
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const result = await generateObject({
      model,
      schema: routingDecisionSchema,
      system: ROUTER_SYSTEM,
      messages: context.messages,
    });

    decision = result.object;
    promptTokens = result.usage?.inputTokens ?? 0;
    completionTokens = result.usage?.outputTokens ?? 0;
  } catch {
    // A router failure must not take the turn down with it. Fallback can still
    // hold a useful conversation, and the customer gets an answer rather than
    // an error page.
    return {
      intent: 'fallback',
      confidence: 0,
      reasoning: 'The router could not classify this message, so a general handler picked it up.',
      fellBack: true,
      originalIntent: 'fallback',
      durationMs: Math.round(performance.now() - startedAt),
      promptTokens,
      completionTokens,
    };
  }

  // Only a *specialist* pick that we overrode counts as falling back. A
  // low-confidence 'fallback' was already headed there, and labelling it as an
  // override would make the trace claim a decision was reversed when it wasn't.
  const belowThreshold = decision.confidence < ROUTING_CONFIDENCE_THRESHOLD;
  const overrode = belowThreshold && decision.intent !== 'fallback';

  return {
    intent: belowThreshold ? 'fallback' : decision.intent,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    fellBack: overrode,
    originalIntent: decision.intent,
    durationMs: Math.round(performance.now() - startedAt),
    promptTokens,
    completionTokens,
  };
}
