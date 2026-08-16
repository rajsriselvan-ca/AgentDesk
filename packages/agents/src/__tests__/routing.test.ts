import { describe, expect, it } from 'vitest';
import { ROUTING_CONFIDENCE_THRESHOLD } from '@agentdesk/core';

import { classifyIntent } from '../mock/classify.js';
import { classifyPromptIntent, planToolCall } from '../mock/model.js';

type MockPrompt = Parameters<typeof classifyPromptIntent>[0];

function conversation(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): MockPrompt {
  return messages as unknown as MockPrompt;
}

/**
 * Routing rules.
 *
 * These assert the mock classifier rather than a live model on purpose: the
 * delegation logic is the thing under test, and a model-backed assertion would
 * fail intermittently for reasons that have nothing to do with the code. The
 * real router is exercised in the integration tests, where what matters is that
 * a decision flows through the pipeline — not which decision it was.
 */

describe('classifyIntent', () => {
  it.each([
    ['Where is my order AD-10604?', 'order'],
    ['My parcel has not moved in four days', 'order'],
    ['Can I cancel my order before it ships?', 'order'],
    ['Why was my card declined?', 'billing'],
    ['Where is my refund for AD-10432?', 'billing'],
    ['What am I paying each month for my subscription?', 'billing'],
    ['How long is the returns policy window?', 'support'],
    ['My headphones crackle on one side', 'support'],
    ['What did I contact you about last time?', 'support'],
  ])('routes %j to the %s agent', (message, expected) => {
    const decision = classifyIntent(message);

    expect(decision.intent).toBe(expected);
    expect(decision.confidence).toBeGreaterThanOrEqual(ROUTING_CONFIDENCE_THRESHOLD);
  });

  it.each(['hello', 'hi!', 'thanks', 'good morning'])(
    'sends the greeting %j to fallback with high confidence',
    (greeting) => {
      const decision = classifyIntent(greeting);

      expect(decision.intent).toBe('fallback');
      expect(decision.confidence).toBeGreaterThan(0.9);
    },
  );

  it('sends an unplaceable message to fallback rather than guessing', () => {
    const decision = classifyIntent('I need help with the thing we discussed');

    expect(decision.intent).toBe('fallback');
  });

  it('always produces a reason a customer could read', () => {
    const decision = classifyIntent('Where is my order AD-10604?');

    expect(decision.reasoning.length).toBeGreaterThan(0);
    // The trace panel shows this verbatim, so it must not leak internals.
    expect(decision.reasoning).not.toMatch(/confidence|threshold|classif/i);
  });

  it('keeps confidence inside the range the schema allows', () => {
    for (const message of ['order refund invoice delivery payment', '', 'x']) {
      const decision = classifyIntent(message);
      expect(decision.confidence).toBeGreaterThanOrEqual(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('is ambiguous, not arbitrary, when two domains tie', () => {
    // "cancel" is an order word and "refund" is a billing word. A message that
    // leans equally on both should not confidently pick one.
    const decision = classifyIntent('cancel refund');

    if (decision.intent !== 'fallback') {
      expect(decision.confidence).toBeLessThan(0.95);
    }
  });
});

describe('context-aware mock follow-ups', () => {
  it('keeps a delivery follow-up with Orders and reuses the order reference', () => {
    const prompt = conversation([
      { role: 'user', content: 'Where is order AD-10604?' },
      {
        role: 'assistant',
        content:
          'Order AD-10604 is held at Bristol depot because the address could not be verified.',
      },
      { role: 'user', content: 'Why is it being held?' },
    ]);

    const routing = classifyPromptIntent(prompt);
    const tool = planToolCall('order', 'Why is it being held?', prompt);

    expect(routing.intent).toBe('order');
    expect(routing.reasoning).toContain('AD-10604');
    expect(tool).toEqual({
      toolName: 'checkDeliveryStatus',
      input: { orderReference: 'AD-10604' },
    });
  });

  it('carries an order reference into a cancellation follow-up', () => {
    const prompt = conversation([
      { role: 'user', content: 'Tell me about order AD-10711.' },
      { role: 'assistant', content: 'Order AD-10711 is currently processing.' },
      { role: 'user', content: 'Can you cancel it?' },
    ]);

    const routing = classifyPromptIntent(prompt);
    const tool = planToolCall('order', 'Can you cancel it?', prompt);

    expect(routing.intent).toBe('order');
    expect(tool?.toolName).toBe('requestOrderChange');
    expect(tool?.input.orderReference).toBe('AD-10711');
  });

  it('keeps a refund timing follow-up with Billing', () => {
    const prompt = conversation([
      { role: 'user', content: 'Where is my refund RF-5619?' },
      { role: 'assistant', content: 'Refund RF-5619 is still processing with the card issuer.' },
      { role: 'user', content: 'When will it arrive?' },
    ]);

    const routing = classifyPromptIntent(prompt);
    const tool = planToolCall('billing', 'When will it arrive?', prompt);

    expect(routing.intent).toBe('billing');
    expect(tool).toEqual({
      toolName: 'checkRefundStatus',
      input: { reference: 'RF-5619' },
    });
  });

  it('does not inherit context for a genuinely vague new request', () => {
    const prompt = conversation([
      { role: 'user', content: 'Where is order AD-10604?' },
      { role: 'assistant', content: 'Order AD-10604 is held at the depot.' },
      { role: 'user', content: 'I need help with something.' },
    ]);

    expect(classifyPromptIntent(prompt).intent).toBe('fallback');
  });
});
