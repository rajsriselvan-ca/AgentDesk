# AgentDesk

An AI customer support desk. A router agent reads each incoming message, classifies the intent, and hands the turn to the specialist that owns it — support, orders, or billing — each with its own tools backed by PostgreSQL. Replies stream to the browser over SSE, and every turn records how it was routed and which tools ran.

**It runs with no API key.** The default provider is a deterministic in-process model that drives the same agent, tool, and streaming code as Claude. Set `AI_PROVIDER=anthropic` for real model calls.

---

## Requirements

- Node.js 20.12 or newer
- pnpm 9 or newer (`npm install -g pnpm`)
- PostgreSQL 14 or newer

## Setup

```bash
git clone https://github.com/rajsriselvan-ca/AgentDesk.git
cd AgentDesk
pnpm install
cp .env.example .env
```

Create the two databases (the second is used by the test suite):

```bash
createdb agentdesk && createdb agentdesk_test
```

Then edit `DATABASE_URL` in `.env` if your Postgres does not accept
`postgresql://postgres:postgres@localhost:5432/agentdesk`, and add:

```
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agentdesk_test
```

Apply the schema and load the sample data:

```bash
pnpm db:migrate
pnpm db:seed
```

## Run

```bash
pnpm dev
```

- Web — http://localhost:5173
- API — http://localhost:3001
- Health — http://localhost:3001/health

Pick one of the three seeded customers from the dropdown and ask something. Try:

| Ask | Routes to | Because the seed contains |
| --- | --- | --- |
| Where is my order AD-10604? | Orders | A parcel held at the depot with an exception scan |
| Why has my refund for AD-10432 not arrived? | Billing | A refund still in flight, with settlement timing |
| Why was my card declined? *(as Milo)* | Billing | Two failed payments — insufficient funds, then expired card |
| My headphones crackle on one side | Support | A troubleshooting article with ordered steps |
| Hello | General | Nothing to route on, so it asks what you need |

Click **Show reasoning** under any reply to see the routing decision, its confidence, the tools that ran, and the token cost.

The message composer stays pinned while long conversations scroll. During a streamed turn, the UI cycles through status text such as **Thinking**, **Searching records**, and **Verifying details**. Deleting a conversation opens a compact confirmation inside the sidebar.

Follow-up messages use the current conversation context, so after asking about `AD-10604`, a question such as **Why is it being held?** stays with the Orders agent and reuses that order reference—even with the mock provider.

For ready-to-use test prompts and expected agent behaviour, see the [Agent Testing Guide](output/pdf/AgentDesk-Agent-Testing-Guide.pdf).

## Docker

If you would rather not install Postgres locally:

```bash
docker compose up -d db
pnpm db:migrate && pnpm db:seed
pnpm dev
```

`docker compose up` alone builds and runs the whole stack (database, API, and web on http://localhost:8080).

---

## Configuration

Every value has a working default except `DATABASE_URL`. See `.env.example` for the full list; these are the ones worth knowing:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | Required. |
| `TEST_DATABASE_URL` | — | Required to run tests. Must contain "test". |
| `AI_PROVIDER` | `mock` | `mock` or `anthropic`. |
| `ANTHROPIC_API_KEY` | — | Required when `AI_PROVIDER=anthropic`. |
| `AGENT_MODEL` | `claude-opus-5` | Router and specialists. |
| `COMPACTION_MODEL` | `claude-haiku-4-5` | Summarising old history only. |
| `RATE_LIMIT_CHAT_MAX` | `15` | Messages per minute per user. |
| `CONTEXT_TOKEN_BUDGET` | `6000` | Above this, old history is compacted. |
| `AGENT_MAX_STEPS` | `6` | Tool-calling steps per turn. |

### Using Claude

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# in .env:
AI_PROVIDER=anthropic
```

Nothing else changes. The mock is a real `LanguageModelV3`, so both providers run through the same `streamText` / `generateObject` calls.

---

## API

All `/api` routes except `/api/agents` require an `x-user-id` header — see [Authentication](#authentication).

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/chat/messages` | Send a message. Responds with an SSE stream. |
| `GET` | `/api/chat/conversations` | List conversations (`?limit=`, `?cursor=`). |
| `GET` | `/api/chat/conversations/:id` | Full history with per-message traces. |
| `DELETE` | `/api/chat/conversations/:id` | Delete a conversation. |
| `GET` | `/api/agents` | List the agents. |
| `GET` | `/api/agents/:type/capabilities` | Tools and JSON Schemas for one agent. |
| `GET` | `/api/users` | Seeded demo users (for the picker). |
| `GET` | `/health` | Liveness plus database and provider checks. |

```bash
curl -N -X POST localhost:3001/api/chat/messages \
  -H 'content-type: application/json' \
  -H "x-user-id: $(curl -s localhost:3001/api/users | jq -r '.users[0].id')" \
  -d '{"content":"Where is my order AD-10604?"}'
```

### Streaming events

A turn always ends with exactly one `done` or one `error`.

| Event | Meaning |
| --- | --- |
| `status` | Phase changed: `received`, `routing`, `thinking`, `calling_tool`, `writing`, `compacting`. |
| `conversation` | A new conversation was created. |
| `user-message` | The persisted user message, for reconciling optimistic ids. |
| `routed` | Chosen agent, confidence, and rationale. |
| `tool-call` / `tool-result` | A tool started / finished. Both carry the same `callId`. |
| `text-delta` | A chunk of the reply. |
| `done` | The persisted assistant message plus usage. |
| `error` | Code, message, and whether retrying is worthwhile. |

### Errors

Every failure returns the same shape. `requestId` matches the `x-request-id` response header and the server log line.

```json
{ "error": { "code": "NOT_FOUND", "message": "Conversation was not found.", "requestId": "…" } }
```

`VALIDATION_FAILED` · `UNAUTHENTICATED` · `NOT_FOUND` · `RATE_LIMITED` · `AGENT_FAILED` · `TOOL_TIMEOUT` · `PROVIDER_UNAVAILABLE` · `INTERNAL`

---

## Architecture

```
apps/
  api/     Hono server. routes → controllers → services → repositories.
  web/     React + Vite. Typed against the API through Hono RPC.
packages/
  core/    Zod schemas, DTOs, error hierarchy, env parsing.
  db/      Drizzle schema, migrations, seed, repositories.
  agents/  Router, three specialists, tools, provider abstraction.
  config/  Shared tsconfig presets.
```

**A turn.** The stream opens before routing so the UI can show a truthful state → the user message is persisted → context is assembled (rolling summary + recent messages) → the router returns `{intent, confidence, reasoning}` → below 0.6 confidence it goes to the fallback handler instead → the chosen specialist streams its reply, calling only its own tools → the message and its trace are persisted in one transaction.

**Layer rules.** Routes declare paths and validation. Controllers do HTTP only. Services own orchestration and transactions and never touch `Context`. Repositories are the only place Drizzle queries are written. Errors are thrown, never returned, and one `onError` handler maps them to responses.

### Tools

| Agent | Tools |
| --- | --- |
| Support | `searchConversationHistory`, `getFaqArticle`, `getTroubleshootingSteps` |
| Orders | `listOrders`, `getOrderDetails`, `checkDeliveryStatus`, `requestOrderChange` |
| Billing | `getInvoice`, `listInvoices`, `listPayments`, `checkRefundStatus`, `getSubscription` |
| General | none — answers from context and asks a clarifying question |

Two properties worth knowing:

**No tool takes a user id.** Tool arguments are model-generated text, so the caller's identity is injected from the request context and every query is filtered by it. A hallucinated order reference returns a not-found, never another customer's data.

**Agents cannot write.** `requestOrderChange` records a request for human review and returns its status; it does not cancel anything. Eligibility is decided by a plain function on the order's status, not by the model.

### Context management

Each turn assembles the rolling summary plus the last N messages, and the router and specialist see the same context. When the estimate exceeds `CONTEXT_TOKEN_BUDGET`, the oldest half is summarised by the cheaper model, stored on the conversation, and replayed as one system message from then on.

---

## Development

```bash
pnpm dev          # api + web
pnpm test         # 56 unit and API integration tests
pnpm typecheck    # all packages
pnpm build        # production build
pnpm db:reset     # drop, migrate, reseed
pnpm db:studio    # browse the database
```

### Tests

Set `TEST_DATABASE_URL` in `.env` to a separate PostgreSQL database whose name contains `test`, then run:

```bash
pnpm test
```

The Vitest suite currently contains 56 tests covering agent routing and tools, contextual follow-ups, API validation, conversation persistence and deletion, user isolation, streaming chat, and rate limiting. The test database is migrated and reseeded before each run. Setup refuses any database URL that does not contain `test`, protecting development data from an accidental reset.

For watch mode while developing:

```bash
pnpm test:watch
```

### End-to-end type safety

`apps/web` imports the API's route type and derives its client from it — no generated client, no duplicated response types. A renamed field is a compile error in the browser code.

This has one sharp edge worth knowing about. If the API's source fails to typecheck *under the web's tsconfig*, TypeScript does not raise an error at the call site — it degrades the inferred type to `any`, and every RPC response silently becomes assignable to anything while `pnpm typecheck` still passes. That is why `apps/web/tsconfig.json` includes Node types, and why `apps/web/src/lib/rpc-guard.ts` asserts the contract by type identity. If that guard starts failing, fix what stopped compiling in the API — do not weaken the assertion.

---

## Authentication

There is none, deliberately. The demo carries the caller in an `x-user-id` header validated against a seeded user, and the UI has a picker for it. A hand-rolled token here would look like security without being it.

`apps/api/src/middleware/identity.ts` occupies exactly the slot a session or token check would. Replacing it means changing that one file: every handler already reads the caller through `getUser`, and every repository is already scoped by user id.

## Deploying

`pnpm build` produces `apps/api/dist` (Node server) and `apps/web/dist` (static files). Set the environment variables above, run migrations against the target database, then start the API with `node apps/api/dist/server.js` and serve the web build from any static host with `VITE_API_URL` pointing at the API.

The included `Dockerfile` and `docker-compose.yml` do this end to end.

## Known limits

- **Rate limiting is in-process.** Correct for one node; behind several instances it becomes per-instance and the store should move to Redis. The middleware interface would not change.
- **History search uses `ILIKE`.** Honest at this data size. A production desk would use `tsvector` or a vector index; the tool contract would be identical.
- **The `workflow` SDK is not wired in.** Its Hono integration requires adopting Nitro as the build system for the whole API, which was judged too much risk to the foundation for the value. Durable escalation is modelled with the `action_requests` table instead.
