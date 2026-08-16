import { createMiddleware } from 'hono/factory';
import { getEnv } from '@agentdesk/core/env';
import { RateLimitError } from '@agentdesk/core';

import type { AppVariables } from '../lib/context.js';

/**
 * Sliding-window rate limiting.
 *
 * Two buckets, because the endpoints are not equally expensive: reads are
 * cheap and get a generous allowance, while sending a message costs a model
 * call and gets a much tighter one. A single shared limit would either throttle
 * harmless list requests or leave the expensive path wide open.
 *
 * The window is a genuine sliding one rather than a fixed bucket — a fixed
 * bucket lets a caller spend the whole allowance at 59.9s and again at 60.1s,
 * which is double the intended rate at exactly the wrong moment.
 *
 * State is in-process, which is right for a single-node deployment and honest
 * about its limit: behind more than one instance this becomes per-instance, and
 * the store should move to Redis. The interface below would not change.
 */

interface Hit {
  timestamps: number[];
}

const buckets = new Map<string, Hit>();

// Bound the map so a burst of unique keys cannot grow it without limit.
const MAX_TRACKED_KEYS = 10_000;

function prune(now: number, windowMs: number): void {
  if (buckets.size < MAX_TRACKED_KEYS) return;

  for (const [key, hit] of buckets) {
    const live = hit.timestamps.filter((at) => now - at < windowMs);
    if (live.length === 0) buckets.delete(key);
    else hit.timestamps = live;
  }
}

export type LimitKind = 'read' | 'chat';

export function rateLimit(kind: LimitKind) {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const env = getEnv();
    const windowMs = env.RATE_LIMIT_WINDOW_MS;
    const max = kind === 'chat' ? env.RATE_LIMIT_CHAT_MAX : env.RATE_LIMIT_READ_MAX;

    // Key on user *and* IP. User alone lets one person burn the limit from
    // everywhere; IP alone punishes everyone behind a shared NAT.
    const user = c.get('user');
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'unknown';
    const key = `${kind}:${user?.id ?? 'anon'}:${ip}`;

    const now = Date.now();
    prune(now, windowMs);

    const hit = buckets.get(key) ?? { timestamps: [] };
    hit.timestamps = hit.timestamps.filter((at) => now - at < windowMs);

    const remaining = Math.max(0, max - hit.timestamps.length - 1);

    c.header('RateLimit-Limit', String(max));
    c.header('RateLimit-Remaining', String(Math.max(0, remaining)));
    c.header('RateLimit-Policy', `${max};w=${Math.round(windowMs / 1000)}`);

    if (hit.timestamps.length >= max) {
      const oldest = hit.timestamps[0] ?? now;
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      buckets.set(key, hit);

      c.header('RateLimit-Remaining', '0');
      throw new RateLimitError(retryAfter);
    }

    hit.timestamps.push(now);
    buckets.set(key, hit);

    await next();
  });
}

/** Test seam — lets a suite start from a known state. */
export function resetRateLimits(): void {
  buckets.clear();
}
