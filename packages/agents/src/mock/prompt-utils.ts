import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';

/**
 * Reading the prompt the AI SDK hands to a language model.
 *
 * The mock model has to answer two questions on every call: what did the
 * customer actually say, and have my tools already run? Both are answered by
 * inspecting the prompt rather than by keeping state, which keeps the mock
 * stateless and therefore safe to share across concurrent turns.
 */

type Prompt = LanguageModelV3CallOptions['prompt'];

export function lastUserText(prompt: Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const message = prompt[i];
    if (message?.role !== 'user') continue;

    if (typeof message.content === 'string') return message.content;

    return message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}

export interface ObservedToolResult {
  toolName: string;
  output: unknown;
}

/** Tool results already in the prompt — i.e. what came back from the last round. */
export function observedToolResults(prompt: Prompt): ObservedToolResult[] {
  const results: ObservedToolResult[] = [];

  for (const message of prompt) {
    if (message.role !== 'tool') continue;

    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;

      const output = part.output;
      let value: unknown = output;

      // Tool output arrives wrapped in a typed envelope; unwrap the payload.
      if (output && typeof output === 'object' && 'type' in output) {
        const envelope = output as { type: string; value?: unknown };
        if (envelope.type === 'json' || envelope.type === 'text') value = envelope.value;
      }

      results.push({ toolName: part.toolName, output: value });
    }
  }

  return results;
}

export function hasToolResults(prompt: Prompt): boolean {
  return observedToolResults(prompt).length > 0;
}

/** Pull an order reference (AD-10432) out of free text. */
export function extractOrderReference(text: string): string | null {
  return text.match(/\bAD-\d{3,6}\b/i)?.[0]?.toUpperCase() ?? null;
}

export function extractInvoiceNumber(text: string): string | null {
  return text.match(/\bINV-\d{3,6}\b/i)?.[0]?.toUpperCase() ?? null;
}

export function extractRefundReference(text: string): string | null {
  return text.match(/\bRF-\d{3,6}\b/i)?.[0]?.toUpperCase() ?? null;
}
