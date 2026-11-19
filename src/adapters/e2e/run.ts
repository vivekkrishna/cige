/**
 * Runs one CIGE case inside an e2e test body: the shared plan
 * (`core/execute.ts`) on an e2e session, so each Execution step is its own
 * `agent.act` goal (or `agent.assert` check) with the guardrails on its
 * instruction and the structured ones checked after every action, then every
 * piece of evidence, then the Intent itself, judged on the screen.
 */

import type { TestFixtures } from 'e2e';

import { executePlan, type CigeHook as CoreHook, type CigeHooks as CoreHooks } from '../../core/execute.ts';
import type { CigePlugin } from '../../core/plugins.ts';
import type { CigeCase } from '../../core/schema.ts';
import { e2eSession } from './session.ts';

export { missingHooks } from '../../core/execute.ts';
export { missingStepKinds } from '../../core/plugins.ts';

/** A precondition or evidence hook, typed for e2e's test fixtures. See `core/execute.ts`. */
export type CigeHook<Fixtures = TestFixtures> = CoreHook<Fixtures>;

export type CigeHooks<Fixtures = TestFixtures> = CoreHooks<Fixtures>;

export interface RunCigeOptions<Fixtures = TestFixtures> {
  /** The hooks the case's preconditions and evidence name. */
  readonly hooks?: CigeHooks<Fixtures>;
  /** The config's plugins: their `onAction` checks and the step kinds `use` steps name. */
  readonly plugins?: readonly CigePlugin<Fixtures, any, any>[];
}

/** Runs one CIGE case against the test's fixtures. Throws on the first step that does not hold. */
export async function runCige<Fixtures extends TestFixtures>(testCase: CigeCase, fixtures: Fixtures, options: RunCigeOptions<Fixtures> = {}): Promise<void> {
  const plugins = options.plugins ?? [];
  await executePlan(testCase, e2eSession(testCase, fixtures, plugins), { ...(options.hooks === undefined ? {} : { hooks: options.hooks }), plugins });
}
