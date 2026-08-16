import { z } from 'zod';
import { findTroubleshooting, listFaqTopics, searchFaq, searchUserMessages } from '@agentdesk/db';

import { defineTool } from './define.js';

/** Tools for the support agent: knowledge base plus the customer's own history. */

export const searchConversationHistoryTool = defineTool({
  name: 'searchConversationHistory',
  description:
    "Search the customer's own past conversations with support. Use this when they refer to something they raised before — 'like I said last time', 'the issue from last week' — or when knowing the history changes the answer. Only ever returns this customer's conversations.",
  inputSchema: z.object({
    query: z.string().min(1).describe('Words to look for, e.g. "headphones rattle".'),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  execute: (input, ctx) =>
    searchUserMessages(ctx.userId, input.query, input.limit, ctx.conversationId ?? undefined),
  summarize: (matches) =>
    matches.length === 0 ? 'nothing in past conversations' : `${matches.length} past message(s)`,
});

export const getFaqArticleTool = defineTool({
  name: 'getFaqArticle',
  description:
    'Search the help centre for policy and how-to answers: delivery times, the returns window, refund timing, plan changes. Use this before answering any policy question from memory.',
  inputSchema: z.object({
    topic: z.string().min(1).describe('What to look for, e.g. "returns window".'),
    limit: z.number().int().min(1).max(5).default(3),
  }),
  execute: async (input, ctx) => {
    void ctx;
    const articles = await searchFaq(input.topic, input.limit);
    if (articles.length > 0) return { articles };

    // An empty result plus the list of topics that do exist is far more useful
    // to the agent than an empty result alone.
    return { articles: [], availableTopics: await listFaqTopics() };
  },
  summarize: (result) =>
    result.articles.length === 0
      ? 'no matching article'
      : `${result.articles.length} article(s)`,
});

export const getTroubleshootingStepsTool = defineTool({
  name: 'getTroubleshootingSteps',
  description:
    'Fetch ordered remediation steps for a described symptom, e.g. "tracking not updating" or "headphones crackling". Use this when the customer has a fault to diagnose rather than a policy question.',
  inputSchema: z.object({
    symptom: z.string().min(1).describe('The problem in the customer\'s own words.'),
    limit: z.number().int().min(1).max(3).default(2),
  }),
  execute: async (input, ctx) => {
    void ctx;
    const articles = await findTroubleshooting(input.symptom, input.limit);
    return { articles };
  },
  summarize: (result) =>
    result.articles.length === 0
      ? 'no steps for that symptom'
      : `${result.articles.length} guide(s)`,
});

export const supportToolFactories = [
  searchConversationHistoryTool,
  getFaqArticleTool,
  getTroubleshootingStepsTool,
];
