import { ROUTING_CONFIDENCE_THRESHOLD, type AgentType, type RoutingDecision } from '@agentdesk/core';

/**
 * Rule-based intent classification, used by the mock model.
 *
 * This is not pretending to be a language model. It is a transparent, testable
 * stand-in that lets the entire pipeline — routing, delegation, tool calling,
 * streaming, persistence — run and be asserted on without a network call or an
 * API key. When AI_PROVIDER=anthropic, the real router replaces this and
 * nothing else in the system changes.
 *
 * It is also useful on its own: the routing tests assert against these rules,
 * so a regression in the delegation logic fails deterministically rather than
 * depending on what a model happened to say that day.
 */

interface Rule {
  agent: Exclude<AgentType, 'fallback'>;
  /** Distinctive terms. A hit here is strong evidence. */
  strong: string[];
  /** Supporting terms. Only meaningful alongside a strong hit or in numbers. */
  weak: string[];
}

const RULES: Rule[] = [
  {
    agent: 'order',
    strong: [
      'order', 'parcel', 'package', 'delivery', 'deliver', 'shipping', 'shipped', 'tracking',
      'track', 'courier', 'dispatch', 'cancel my order',
    ],
    // "where is my" is deliberately weak, not strong. It is the opening of
    // "where is my parcel" *and* "where is my refund", so treating it as strong
    // evidence for orders made every refund chase route to the wrong desk.
    weak: [
      'arrive', 'late', 'delayed', 'stuck', 'lost', 'address', 'cancel', 'return it',
      'where is my',
    ],
  },
  {
    agent: 'billing',
    strong: [
      'invoice', 'refund', 'payment', 'card', 'charged', 'charge', 'billing', 'bill',
      'subscription', 'plan', 'declined', 'money back', 'paid', 'overdue',
    ],
    weak: ['cost', 'price', 'amount', 'receipt', 'renew', 'upgrade', 'downgrade', 'owe'],
  },
  {
    agent: 'support',
    strong: [
      'how do i', 'how long', 'policy', 'warranty', 'broken', 'faulty', 'not working',
      'crackle', 'crackling', 'rattle', 'troubleshoot', 'last time', 'previously', 'earlier',
      'help centre', 'help center',
    ],
    weak: ['issue', 'problem', 'question', 'fix', 'setup', 'guide', 'steps', 'before'],
  },
];

const GREETINGS = /^(hi|hey|hello|yo|good (morning|afternoon|evening)|thanks|thank you|ok|okay)\b[\s!.?]*$/i;

export function classifyIntent(message: string): RoutingDecision {
  const text = message.toLowerCase().trim();

  if (text.length === 0 || GREETINGS.test(text)) {
    return {
      intent: 'fallback',
      confidence: 0.95,
      reasoning: 'A greeting or acknowledgement with no request attached.',
    };
  }

  const scored = RULES.map((rule) => {
    const strongHits = rule.strong.filter((term) => text.includes(term));
    const weakHits = rule.weak.filter((term) => text.includes(term));
    return { agent: rule.agent, score: strongHits.length * 2 + weakHits.length, strongHits, weakHits };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];

  if (!best || best.score === 0) {
    return {
      intent: 'fallback',
      confidence: 0.3,
      reasoning: 'Nothing in the message points at orders, billing, or a support topic.',
    };
  }

  // Confidence rises with the margin over the runner-up, not with raw score.
  // A message that scores 4 on both billing and orders is genuinely ambiguous,
  // and should land in fallback rather than pick one arbitrarily.
  const margin = best.score - (runnerUp?.score ?? 0);
  const confidence = Math.min(0.95, 0.45 + best.score * 0.08 + margin * 0.12);

  const evidence = [...best.strongHits, ...best.weakHits].slice(0, 3);

  if (confidence < ROUTING_CONFIDENCE_THRESHOLD) {
    return {
      intent: 'fallback',
      confidence,
      reasoning:
        runnerUp && runnerUp.score === best.score
          ? `Reads as both ${best.agent} and ${runnerUp.agent}; too ambiguous to route confidently.`
          : 'Not enough signal to place this with a specialist.',
    };
  }

  return {
    intent: best.agent,
    confidence: Number(confidence.toFixed(2)),
    reasoning: `Mentions ${evidence.map((term) => `"${term}"`).join(', ')}, which is ${best.agent} territory.`,
  };
}
