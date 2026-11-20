/**
 * One CIGE case inside a Playwright test, as a CIGE session:
 *
 * 1. One `context.route()` per guardrail `x-deny-requests` entry: a match is
 *    aborted and recorded, so the operation it happened in fails as that
 *    guardrail's violation, even when the binding or the app swallowed the
 *    aborted request (enforced, not advisory).
 * 2. Each operation in its own `test.step`, titled `CIGE <id> · <text>`, so
 *    the report and the trace show which part of the case ran.
 * 3. An `act` or `verify` step runs its binding: Playwright code an agent or a
 *    person wrote once, run on every run with no model call.
 * 4. The Intent and evidence `assert` items, when the case judges them on the
 *    screen, go to the runner's `judge`; hook evidence is the config's code.
 *
 * A binding's own error is thrown as is, so Playwright reports it as it
 * always does; the suite reads what it means (`errors.ts`).
 */

import type { CigeJudgeOp, CigeSession, CigeVerifyOp } from '../../core/contract.ts';
import { denyRequests } from '../../core/deny-requests.ts';
import { CigeError, codedError, isCigeError, signalsForCode } from '../../core/errors.ts';
import type { CigeOp } from '../../core/plan.ts';
import type { CigeCase } from '../../core/schema.ts';
import { isExpectFailure, plainMessage } from './errors.ts';
import type { CigeBindings, CigeBoundStep, CigeJudge, CigePlaywrightFixtures } from './types.ts';

/** A request a guardrail's `x-deny-requests` blocked. */
export interface BlockedRequest {
  readonly guardrail: string;
  readonly request: string;
}

export interface PlaywrightSessionOptions {
  readonly bindings: CigeBindings;
  readonly judge?: CigeJudge;
  /** The case's Context as the judge reads it. */
  readonly agentContext?: string;
  /** `test.step` of the test the case registered through. */
  readonly step: <T>(title: string, body: () => Promise<T>) => Promise<T>;
}

export interface PlaywrightSession {
  readonly session: CigeSession<CigePlaywrightFixtures>;
  /** Every request a guardrail blocked, in order. */
  readonly blocked: readonly BlockedRequest[];
}

const PROVIDER = /api[ _-]?key|provider|unauthori[sz]ed|\b40[13]\b|\b429\b|rate.?limit|quota|overloaded/i;

/** The title of an operation's `test.step`: what the reporter reads the failed operation back from. */
export function stepTitle(op: CigeOp): string {
  if (op.kind === 'precondition') return `CIGE precondition ${op.hook}`;
  if (op.kind === 'open') return `CIGE open ${op.url}`;
  const text = op.kind === 'use' ? `use ${op.step.use}` : op.kind === 'evidence' ? `hook ${op.hook}` : op.text;
  const line = text.split('\n')[0]!.trim();
  return `CIGE ${op.id} · ${line.length > 80 ? `${line.slice(0, 79)}…` : line}`;
}

/** The operation id a `test.step` title names, when it is a CIGE step that has one. */
export function opIdOfTitle(title: string): string | undefined {
  return /^CIGE ([A-Za-z0-9][A-Za-z0-9._-]*) · /.exec(title)?.[1];
}

/** Opens the case's session on a test's fixtures: routes its denied requests, then hands back the session. */
export async function startPlaywrightSession(testCase: CigeCase, fixtures: CigePlaywrightFixtures, options: PlaywrightSessionOptions): Promise<PlaywrightSession> {
  const { page, context, testInfo } = fixtures;
  const blocked: BlockedRequest[] = [];
  const denied = denyRequests(testCase);
  if (denied.problems.length > 0) throw new CigeError('TEST_SETUP_FAILED', denied.problems.join('; '));
  for (const rule of denied.rules) {
    await context.route(rule.pattern, async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      if (rule.method !== undefined && method !== rule.method) return route.fallback();
      blocked.push({ guardrail: rule.guardrail, request: `${method} ${request.url()}` });
      return route.abort('blockedbyclient');
    });
  }

  /** The violation for the first request blocked since `before`, if any. */
  const violationSince = (before: number, cause?: unknown): CigeError | undefined => {
    const first = blocked[before];
    if (first === undefined) return undefined;
    const rule = testCase.guardrails.find((entry) => entry.id === first.guardrail);
    return new CigeError('POLICY_DENIED', `CIGE guardrail ${first.guardrail} violated by request ${first.request} (blocked). Guardrail: ${rule?.rule ?? ''}`, {
      ...(cause === undefined ? {} : { cause }),
      signals: [{ kind: 'guardrail.violated', detail: first.guardrail }],
    });
  };

  const bound = (id: string): { binding: CigeBindings[string]; step: CigeBoundStep } => {
    const step = testCase.execution.find((entry): entry is CigeBoundStep => entry.id === id && entry.kind !== 'use');
    const binding = Object.hasOwn(options.bindings, id) ? options.bindings[id] : undefined;
    // cigeTest refuses a case with an unbound step before it registers; this is the guard for a direct caller.
    if (step === undefined || binding === undefined) throw new CigeError('STEP_NOT_COMPILED', `CIGE step ${id} has no binding: write its Playwright code (npx cige compile ${testCase.id})`, { signals: [] });
    return { binding, step };
  };
  const runBinding = async (id: string, extra: Readonly<Record<string, unknown>> | undefined): Promise<void> => {
    const { binding, step } = bound(id);
    await binding({ ...fixtures, testCase, step, params: { ...testCase.params, ...extra } });
  };

  const judged = async (op: CigeVerifyOp | CigeJudgeOp, kind: 'intent' | 'evidence'): Promise<void> => {
    const label = kind === 'intent' ? 'The Intent' : `CIGE evidence ${op.id}`;
    if (options.judge === undefined) {
      throw new CigeError('TEST_SETUP_FAILED', `${label} is judged on the screen, and playwrightRunner has no judge: set judge, or prove it with hook evidence and "judge": false`);
    }
    let verdict: Awaited<ReturnType<CigeJudge>>;
    try {
      verdict = await options.judge({ claim: op.text, kind, id: op.id, context: options.agentContext, testCase, page, testInfo });
    } catch (cause) {
      if (isCigeError(cause)) throw cause;
      const message = `${label}: the judge failed: ${plainMessage(cause)}`;
      if (PROVIDER.test(plainMessage(cause))) throw new CigeError('PROVIDER_ERROR', message, { cause, signals: [{ kind: 'provider.error' }] });
      throw new CigeError('ASSERTION_INCONCLUSIVE', message, { cause });
    }
    const why = verdict.summary === undefined || verdict.summary === '' ? '' : `: ${verdict.summary}`;
    if (verdict.status === 'passed') return;
    if (verdict.status === 'failed') throw new CigeError('ASSERTION_FAILED', `${label} was judged false${why}`, { signals: [{ kind: 'assert.false' }] });
    if (verdict.status === 'inconclusive') throw new CigeError('ASSERTION_INCONCLUSIVE', `${label} could not be judged${why}`, { signals: [{ kind: 'assert.inconclusive' }] });
    throw new CigeError('TEST_SETUP_FAILED', `${label}: the judge returned status ${JSON.stringify((verdict as { status?: unknown }).status)}; it must be passed, failed, or inconclusive`);
  };

  const session: CigeSession<CigePlaywrightFixtures> = {
    runner: 'playwright',
    fixtures,
    async open(url) {
      const base = fixtures.baseURL;
      const target = base === undefined || /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : new URL(url, base).href;
      try {
        await page.goto(target);
      } catch (cause) {
        throw new CigeError('ENVIRONMENT_UNAVAILABLE', `could not open ${target}: ${plainMessage(cause)}`, { cause });
      }
    },
    async act(op) {
      await runBinding(op.id, op.params);
    },
    async verify(op) {
      if (op.phase === 'evidence') return judged(op, 'evidence');
      await runBinding(op.id, undefined);
    },
    async judge(op) {
      await judged(op, 'intent');
    },
    async group(op, run) {
      return options.step(stepTitle(op), async () => {
        const before = blocked.length;
        let result: Awaited<ReturnType<typeof run>>;
        try {
          result = await run();
        } catch (cause) {
          // The binding may have failed only because its request was aborted: the guardrail is the verdict.
          throw violationSince(before, cause) ?? cause;
        }
        const violation = violationSince(before);
        if (violation !== undefined) throw violation;
        return result;
      });
    },
    failure(code, message, { cause, op }) {
      return new CigeError(code, message, { ...(cause === undefined ? {} : { cause }), signals: signalsForCode(code, op) });
    },
    keeps: (cause) => isCigeError(cause),
    translate(cause) {
      if (isCigeError(cause)) return cause;
      // A hook that checks with `expect` and finds the value wrong said no, as returning false would.
      if (isExpectFailure(cause) && !/element\(s\) not found/.test(plainMessage(cause))) return new CigeError('ASSERTION_FAILED', plainMessage(cause), { cause });
      const coded = codedError(cause);
      // An e2e AgentError a shared hook threw keeps its code here too.
      return coded === undefined ? cause : new CigeError(coded.code, coded.message, { cause });
    },
  };
  return { session, blocked };
}
