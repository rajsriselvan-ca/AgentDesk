import { parseChatStreamEvent, type ChatStreamEvent } from '@agentdesk/core';

import { apiUrl, authHeaders } from './api.js';

/**
 * Consuming the chat stream.
 *
 * `EventSource` is not usable here: it only issues GETs, and it cannot send the
 * identity header. So this reads the response body directly and parses the SSE
 * framing, which is a handful of lines and gives us abort support for free.
 *
 * The buffering matters. A network chunk boundary can land anywhere, including
 * the middle of a JSON payload, so events are only parsed once a blank line has
 * confirmed the frame is complete.
 */

export interface StreamHandlers {
  onEvent: (event: ChatStreamEvent) => void;
  /** Transport-level failure — the turn stopped without a terminal event. */
  onTransportError: (error: Error) => void;
  onClose: () => void;
}

export interface SendMessageRequest {
  conversationId?: string | undefined;
  content: string;
}

export function streamChatMessage(
  request: SendMessageRequest,
  handlers: StreamHandlers,
): { abort: () => void } {
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(apiUrl('/api/chat/messages'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        // A failure before the stream opened comes back as our normal JSON
        // error body rather than as SSE.
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string; code?: string } }
          | null;

        const retryAfter = response.headers.get('Retry-After');
        const suffix = retryAfter ? ` Try again in ${retryAfter}s.` : '';

        throw new Error(
          (body?.error?.message ?? `The request failed with status ${response.status}.`) + suffix,
        );
      }

      if (!response.body) throw new Error('The server returned no stream to read.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line. Anything after the last one is
        // an incomplete frame and stays in the buffer.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;

            const event = parseChatStreamEvent(line.slice(5).trim());
            if (event) handlers.onEvent(event);
          }
        }
      }

      handlers.onClose();
    } catch (error) {
      if (controller.signal.aborted) {
        handlers.onClose();
        return;
      }

      handlers.onTransportError(
        error instanceof Error ? error : new Error('The connection failed.'),
      );
    }
  })();

  return { abort: () => controller.abort() };
}
