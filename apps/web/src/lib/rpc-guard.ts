/**
 * Compile-time guard on the Hono RPC contract.
 *
 * The reason this file exists: when the API's source fails to typecheck under
 * the web tsconfig, TypeScript does not report an error at the call site — it
 * degrades the inferred `AppType` to `any`, and every RPC response silently
 * becomes assignable to anything. `pnpm typecheck` still passes. The end-to-end
 * type safety this monorepo exists for is gone, and nothing says so.
 *
 * A normal assertion cannot catch that, because everything is assignable to
 * `any`. `Equal` below is the standard trick that does: it compares types by
 * identity rather than assignability, so `Equal<any, 'ok'>` is `false` and the
 * `Expect` fails to compile.
 *
 * If this file starts erroring, do not weaken the assertion. Run
 * `pnpm --filter @agentdesk/web typecheck` and fix whatever in the API source
 * no longer compiles from the browser's point of view.
 */

import type { HealthDTO } from '@agentdesk/core';
import { api } from './api.js';

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

type HealthResponse = Awaited<ReturnType<Awaited<ReturnType<typeof api.health.$get>>['json']>>;

// If the RPC types have collapsed to `any`, this line stops compiling.
export type RpcContractIsLive = Expect<Equal<HealthResponse['status'], HealthDTO['status']>>;
