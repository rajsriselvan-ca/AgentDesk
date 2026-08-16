import type { LanguageModel } from 'ai';
import { getEnv } from '@agentdesk/core/env';
import { ProviderUnavailableError } from '@agentdesk/core';

import { createMockModel, type ModelRole } from './mock/model.js';

/**
 * Model resolution.
 *
 * The only place in the system that knows whether we are talking to Claude or
 * to the deterministic stand-in. Everything downstream receives a
 * `LanguageModel` and cannot tell the difference, which is what makes the mock
 * worth having: it exercises the real agent code rather than bypassing it.
 */

const mockModels = new Map<ModelRole, LanguageModel>();

function mockFor(role: ModelRole): LanguageModel {
  let model = mockModels.get(role);
  if (!model) {
    model = createMockModel(role) as unknown as LanguageModel;
    mockModels.set(role, model);
  }
  return model;
}

let anthropicProvider: ((modelId: string) => LanguageModel) | null = null;

async function loadAnthropic(): Promise<(modelId: string) => LanguageModel> {
  if (anthropicProvider) return anthropicProvider;

  try {
    // Imported lazily so that a mock-provider deployment never needs the
    // package resolved, and a missing key fails at the call, not at boot.
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const env = getEnv();
    const provider = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    anthropicProvider = (modelId: string) => provider(modelId) as unknown as LanguageModel;
    return anthropicProvider;
  } catch (error) {
    throw new ProviderUnavailableError(
      'The Anthropic provider could not be initialised. Check ANTHROPIC_API_KEY, or set AI_PROVIDER=mock.',
      error,
    );
  }
}

export async function resolveModel(role: ModelRole): Promise<LanguageModel> {
  const env = getEnv();

  if (env.AI_PROVIDER === 'mock') return mockFor(role);

  const anthropic = await loadAnthropic();
  return anthropic(role === 'compaction' ? env.COMPACTION_MODEL : env.AGENT_MODEL);
}

export function describeProvider(): { provider: string; model: string } {
  const env = getEnv();
  return {
    provider: env.AI_PROVIDER,
    model: env.AI_PROVIDER === 'mock' ? 'deterministic-mock' : env.AGENT_MODEL,
  };
}

/**
 * Cheap reachability check for /health.
 *
 * The mock is always reachable. For Anthropic we only verify that the provider
 * can be constructed — a real completion on every health check would be an
 * expensive way to find out something a request would tell us anyway.
 */
export async function checkProvider(): Promise<{ ok: boolean; error?: string }> {
  const env = getEnv();
  if (env.AI_PROVIDER === 'mock') return { ok: true };

  try {
    await loadAnthropic();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'unknown error' };
  }
}
