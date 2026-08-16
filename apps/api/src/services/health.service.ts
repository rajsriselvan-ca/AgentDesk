import { checkProvider, describeProvider } from '@agentdesk/agents';
import type { HealthDTO } from '@agentdesk/core';
import { pingDb } from '@agentdesk/db';

const startedAt = Date.now();

/**
 * Liveness plus dependency checks.
 *
 * The distinction between `ok` and `degraded` is deliberate. Losing the
 * database means the service cannot do anything useful, so that is a hard
 * failure. Losing the model provider means chat is broken but conversation
 * history still reads fine — reporting that as a total outage would have an
 * orchestrator kill a process that is still serving most of its traffic.
 */
export async function getHealth(): Promise<HealthDTO> {
  const [database, modelProvider] = await Promise.all([checkDatabase(), checkModelProvider()]);

  return {
    status: database.ok ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    checks: { database, modelProvider },
  };
}

async function checkDatabase(): Promise<HealthDTO['checks']['database']> {
  try {
    const latencyMs = await pingDb();
    return { ok: true, latencyMs };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

async function checkModelProvider(): Promise<HealthDTO['checks']['modelProvider']> {
  const { provider } = describeProvider();
  const result = await checkProvider();

  return result.ok ? { ok: true, provider } : { ok: false, provider, error: result.error };
}
