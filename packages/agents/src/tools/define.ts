import type { Tool } from 'ai';
import { z } from 'zod';
import { ToolTimeoutError } from '@agentdesk/core';
import type { ToolCallDTO } from '@agentdesk/core';

/**
 * Tool definition helper.
 *
 * Three things every tool in this system gets, without each one re-implementing
 * them:
 *
 *   Scoping — `execute` receives a `ToolContext` carrying the authenticated
 *   user id. The id is never a tool *argument*, because arguments are
 *   model-generated text. A model that invents an order reference gets a
 *   not-found; it cannot ask for somebody else's data.
 *
 *   A timeout — a slow query becomes a tool error the agent can narrate,
 *   rather than a stream that hangs until the browser gives up.
 *
 *   A trace entry — every call is recorded with its arguments, outcome,
 *   one-line summary, and duration. That record is the audit trail and the
 *   source of the reasoning panel in the UI.
 */

export interface ToolContext {
  userId: string;
  conversationId: string | null;
  timeoutMs: number;
  /** Called as each tool call completes, so the SSE stream can push it live. */
  onToolCall?: (call: ToolCallDTO) => void;
}

export interface ToolDefinition<TInput extends z.ZodType, TOutput> {
  name: string;
  description: string;
  inputSchema: TInput;
  execute: (input: z.infer<TInput>, ctx: ToolContext) => Promise<TOutput>;
  /** One line for the trace, e.g. "3 orders" or "no refund found". */
  summarize: (output: TOutput) => string;
}

export interface BuiltTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  tool: Tool;
}

/**
 * `tool()` from the AI SDK is an identity function that exists purely for type
 * inference. We cannot use its inference here (see defineTool), so this is the
 * same thing with the cast in exactly one place.
 */
function buildTool(spec: {
  description: string;
  inputSchema: z.ZodType;
  execute: (input: Record<string, unknown>, options: { toolCallId: string }) => Promise<unknown>;
}): Tool {
  return spec as unknown as Tool;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError(toolName, ms)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function defineTool<TInput extends z.ZodType, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
) {
  return (ctx: ToolContext): BuiltTool => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    // Built as a plain object rather than through the SDK's `tool()` helper.
    // That helper is an identity function whose only job is inference, and its
    // `FlexibleSchema` parameter cannot infer through our own generic — so it
    // buys nothing here and costs an unresolvable overload.
    //
    // Nothing is lost by skipping it. The schema still validates every call at
    // runtime, and `definition.execute` is still typed against `z.infer<TInput>`,
    // so tool authors get full type checking on their own inputs.
    tool: buildTool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      // The call id comes from the SDK rather than being generated here, so the
      // `tool-call` event the model emits and the `tool-result` event this
      // wrapper emits carry the *same* id. Without that, the UI cannot pair a
      // running tool with its outcome and the trace shows orphaned entries.
      execute: async (input: Record<string, unknown>, { toolCallId }) => {
        const callId = toolCallId;
        const startedAt = performance.now();

        try {
          const output = await withTimeout(
            definition.execute(input as z.infer<TInput>, ctx),
            ctx.timeoutMs,
            definition.name,
          );

          ctx.onToolCall?.({
            callId,
            tool: definition.name,
            args: input,
            ok: true,
            summary: definition.summarize(output),
            durationMs: Math.round(performance.now() - startedAt),
          });

          return output;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The lookup failed.';

          ctx.onToolCall?.({
            callId,
            tool: definition.name,
            args: input,
            ok: false,
            summary: message,
            durationMs: Math.round(performance.now() - startedAt),
          });

          // Returned rather than thrown: the agent should tell the customer
          // that the lookup failed, not have the whole turn collapse.
          return { error: message };
        }
      },
    }),
  });
}

export type ToolFactory = ReturnType<typeof defineTool>;

/** Turn a set of built tools into the map the AI SDK expects. */
export function toToolSet(tools: BuiltTool[]): Record<string, Tool> {
  return Object.fromEntries(tools.map((t) => [t.name, t.tool]));
}
