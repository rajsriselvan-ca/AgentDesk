import { hc } from 'hono/client';
import type { AppType } from '@agentdesk/api';

/**
 * The typed API client.
 *
 * `AppType` is imported as a type only, so nothing from the server package
 * reaches the browser bundle — the import disappears entirely at build time.
 * What survives is the compile-time knowledge of every route, its input, and
 * its response shape.
 */

const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/** Identity for the demo. Swapped by the user picker; see README on auth. */
let currentUserId: string | null = null;

export function setCurrentUserId(userId: string | null): void {
  currentUserId = userId;
}

export function getCurrentUserId(): string | null {
  return currentUserId;
}

export function authHeaders(): Record<string, string> {
  return currentUserId ? { 'x-user-id': currentUserId } : {};
}

export const api = hc<AppType>(baseUrl, {
  headers: () => authHeaders(),
});

/** Absolute URL for endpoints consumed outside the RPC client, e.g. the SSE stream. */
export function apiUrl(path: string): string {
  return new URL(path, baseUrl).toString();
}
