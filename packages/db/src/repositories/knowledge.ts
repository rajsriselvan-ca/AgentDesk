import { desc, or, sql, type SQL } from 'drizzle-orm';

import { db } from '../client.js';
import { faqArticles } from '../schema.js';

/** Knowledge-base reads for the support agent. Not user-scoped — public content. */

export interface FaqArticle {
  topic: string;
  question: string;
  body: string;
  tags: string[];
  steps: string[];
}

/**
 * Words too common to be worth matching on.
 *
 * Without this, "how long do I have to return something" matches every article
 * containing "to", and relevance ranking becomes noise.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'for', 'on', 'in', 'at', 'by', 'with', 'from', 'about',
  'i', 'my', 'me', 'we', 'you', 'your', 'it', 'its', 'this', 'that',
  'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'will', 'would',
  'what', 'when', 'where', 'why', 'who', 'how', 'if', 'not', 'no',
  'please', 'help', 'need', 'want', 'get', 'got', 'there', 'some', 'something',
]);

const escapeLike = (value: string): string => value.replace(/[%_\\]/g, (m) => `\\${m}`);

/**
 * Break a natural question into searchable terms.
 *
 * A single ILIKE on the whole phrase is the obvious implementation and it is
 * almost always wrong: "how long do I have to return something" is not a
 * substring of any article, so the search returns nothing and the agent tells
 * the customer there is no policy. Matching per term fixes that, and counting
 * how many terms hit gives a usable relevance order.
 */
function terms(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

  // Fall back to the raw query when it is all stop words or punctuation, so a
  // deliberately short search like "faq" still does something sensible.
  return words.length > 0 ? [...new Set(words)].slice(0, 6) : [query.trim()].filter(Boolean);
}

/** Does any searchable field of the article contain this term? */
function matchesTerm(term: string): SQL {
  const like = `%${escapeLike(term)}%`;
  return sql`(
    ${faqArticles.topic} ilike ${like}
    or ${faqArticles.question} ilike ${like}
    or ${faqArticles.body} ilike ${like}
    or exists (
      select 1 from jsonb_array_elements_text(${faqArticles.tags}) t where t ilike ${like}
    )
  )`;
}

/**
 * Score an article: how many query terms it matches, with topic and question
 * hits weighted above incidental body mentions.
 *
 * The expression is repeated in ORDER BY rather than referenced by name.
 * Drizzle emits no alias for a computed select column, so ordering by one
 * produces a reference to a column that does not exist — and `rank` in
 * particular is a reserved window function, which makes Postgres reject the
 * whole query at parse time.
 */
function relevance(searchTerms: string[]): SQL {
  const parts = searchTerms.map((term) => {
    const like = `%${escapeLike(term)}%`;
    return sql`(
      case when ${faqArticles.topic} ilike ${like} then 3
           when ${faqArticles.question} ilike ${like} then 2
           when ${faqArticles.body} ilike ${like} then 1
           else 0 end
      + case when exists (
          select 1 from jsonb_array_elements_text(${faqArticles.tags}) t where t ilike ${like}
        ) then 2 else 0 end
    )`;
  });

  return sql.join(parts, sql` + `);
}

export async function searchFaq(query: string, limit: number): Promise<FaqArticle[]> {
  const searchTerms = terms(query);
  if (searchTerms.length === 0) return [];

  const anyTermMatches = or(...searchTerms.map(matchesTerm));

  return db
    .select({
      topic: faqArticles.topic,
      question: faqArticles.question,
      body: faqArticles.body,
      tags: faqArticles.tags,
      steps: faqArticles.steps,
    })
    .from(faqArticles)
    .where(anyTermMatches)
    .orderBy(desc(relevance(searchTerms)))
    .limit(limit);
}

export async function listFaqTopics(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ topic: faqArticles.topic })
    .from(faqArticles)
    .orderBy(faqArticles.topic);

  return rows.map((row) => row.topic);
}

/** Articles that carry remediation steps, for the troubleshooting tool. */
export async function findTroubleshooting(symptom: string, limit: number): Promise<FaqArticle[]> {
  const searchTerms = terms(symptom);
  if (searchTerms.length === 0) return [];

  const anyTermMatches = or(...searchTerms.map(matchesTerm));

  return db
    .select({
      topic: faqArticles.topic,
      question: faqArticles.question,
      body: faqArticles.body,
      tags: faqArticles.tags,
      steps: faqArticles.steps,
    })
    .from(faqArticles)
    .where(sql`jsonb_array_length(${faqArticles.steps}) > 0 and ${anyTermMatches}`)
    .orderBy(desc(relevance(searchTerms)))
    .limit(limit);
}
