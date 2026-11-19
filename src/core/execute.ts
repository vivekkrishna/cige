/**
 * Runs one resolved case on a session, in the order the plan makes it:
 * preconditions, then `Context.open`, then each Execution entry, then every
 * piece of evidence, then the Intent. A pass means each of those held: an
 * Execution that merely ran is not a pass. Every runner, hosted or owned,
 * runs a case through this one loop, so a step fails under the same id with
 * the same message whichever runner ran it.
 */

import type { CigeSession, CigeThrowSite } from './contract.ts';
import { messageOf } from './errors.ts';
import { planCase, type CigeOp } from './plan.ts';
import { stepRunnerOf, type AnyPlugin } from './plugins.ts';
import type { CigeCase } from './schema.ts';

/** What a hook learns of the run besides its fixtures. */
export interface CigeHookInfo {
  /** The runner running the case, such as `e2e` or `vibium`. */
  readonly runner: string;
}

/**
 * A precondition or evidence hook: your code, named from the CIGE file.
 * It gets the runner's fixtures (e2e's test fixtures, Vibium's
 * `{ browser, page }`), the resolved case, and which runner it is.
 * An evidence hook holds only when it resolves to `true`: `false`,
 * `undefined` (a forgotten `return`), or any other value fails it as
 * `ASSERTION_FAILED`, so a hook can't pass a case by accident. A throw means
 * the check could not run, not that it failed: a runner's own error or a
 * `CigeError` keeps its code, and any other throw, a Node `ECONNREFUSED`
 * included, is `ASSERTION_INCONCLUSIVE` with its message. A precondition
 * hook's return value is ignored; it fails only by throwing.
 */
export type CigeHook<Fixtures = unknown> = (fixtures: Fixtures, testCase: CigeCase, info: CigeHookInfo) => unknown;

export type CigeHooks<Fixtures = unknown> = Readonly<Record<string, CigeHook<Fixtures>>>;

export interface ExecuteOptions<Fixtures = unknown> {
  /** The hooks the case's preconditions and evidence name. */
  readonly hooks?: CigeHooks<Fixtures>;
  /** The config's plugins: the step kinds `use` steps name. */
  readonly plugins?: readonly AnyPlugin[];
  /** Called before each operation runs: an owned runner learns where a failure landed. */
  readonly onOp?: (op: CigeOp) => void;
}

/** Every hook name the case refers to that `hooks` does not define. */
export function missingHooks(testCase: CigeCase, hooks: Readonly<Record<string, unknown>> = {}): string[] {
  const names = [
    ...testCase.context.preconditions.flatMap((entry) => (entry.kind === 'hook' ? [entry.hook] : [])),
    ...testCase.intent.evidence.flatMap((item) => (item.kind === 'hook' ? [item.hook] : [])),
  ];
  return [...new Set(names)].filter((name) => !Object.hasOwn(hooks, name));
}

/** A hook's return value, short enough for an error message; never throws on a circular or BigInt value. */
function describeValue(value: unknown): string {
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 120);
  } catch {
    return typeof value;
  }
}

/** Runs one resolved case on the session. Throws on the first operation that does not hold. */
export async function executePlan<Fixtures>(testCase: CigeCase, session: CigeSession<Fixtures>, options: ExecuteOptions<Fixtures> = {}): Promise<void> {
  const hooks = options.hooks ?? {};
  const plugins = options.plugins ?? [];
  const { fixtures } = session;
  const info: CigeHookInfo = { runner: session.runner };

  const hookOf = (name: string, op: CigeOp) => {
    const hook = Object.hasOwn(hooks, name) ? hooks[name] : undefined;
    if (hook === undefined) throw session.failure('TEST_SETUP_FAILED', `CIGE hook "${name}" is not defined; pass it in hooks`, { op });
    return hook;
  };
  /** A hook's or step kind's throw: kept when it carries the runner's verdict, else wrapped. */
  const rethrow = (cause: unknown, site: CigeThrowSite): unknown => {
    const error = session.translate?.(cause) ?? cause;
    return session.keeps(error, site) ? error : undefined;
  };

  const run = async (op: CigeOp): Promise<void> => {
    switch (op.kind) {
      case 'precondition': {
        const hook = hookOf(op.hook, op);
        try {
          await hook(fixtures, testCase, info);
        } catch (cause) {
          throw rethrow(cause, 'precondition') ?? session.failure('TEST_SETUP_FAILED', `CIGE precondition ${op.hook} failed: ${messageOf(cause)}`, { cause, op });
        }
        return;
      }
      case 'open':
        return session.open(op.url);
      case 'act':
        return session.act(op);
      case 'verify':
        return session.verify(op);
      case 'use': {
        const runner = stepRunnerOf(plugins, op.step.use, session.runner);
        if (runner === undefined) throw session.failure('TEST_SETUP_FAILED', `CIGE step ${op.id} (${op.step.use}): no plugin registers this step kind`, { op });
        try {
          await runner({ fixtures, testCase, step: op.step, runner: session.runner });
        } catch (cause) {
          throw rethrow(cause, 'use') ?? session.failure('ACTION_FAILED', `CIGE step ${op.id} (${op.step.use}) failed: ${messageOf(cause)}`, { cause, op });
        }
        return;
      }
      case 'evidence': {
        const hook = hookOf(op.hook, op);
        let held: unknown;
        try {
          held = await hook(fixtures, testCase, info);
        } catch (cause) {
          // A backend that is down is not a product defect: only a hook's own verdict is ASSERTION_FAILED.
          throw rethrow(cause, 'evidence') ?? session.failure('ASSERTION_INCONCLUSIVE', `CIGE evidence ${op.id} could not be checked: ${messageOf(cause)}`, { cause, op });
        }
        if (held !== true) {
          const returned = held === undefined ? 'nothing; an evidence hook must return true to hold' : describeValue(held);
          throw session.failure('ASSERTION_FAILED', `CIGE evidence ${op.id} not satisfied: hook ${op.hook} returned ${returned}`, { op });
        }
        return;
      }
      case 'judge':
        return session.judge(op);
    }
  };

  for (const op of planCase(testCase)) {
    options.onOp?.(op);
    await (session.group === undefined ? run(op) : session.group(op, () => run(op)));
  }
}
