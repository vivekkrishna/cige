/**
 * A scripted stand-in for `vibium`: no browser, no model. `page.run` and
 * the checks answer by the marker phrases in the goal or claim, the way a
 * real agent would report each scenario, and `page.route` handlers fire for
 * the requests a scripted goal "sends". Every call is recorded, so a test
 * sees exactly what the adapter asked Vibium for.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { VibiumCheckResult, VibiumModule, VibiumRoute, VibiumRunResult } from '../../src/adapters/vibium/types.ts';
import { CONFORMANCE_MARKERS } from '../../src/runner/conformance.ts';

export interface FakeCall {
  readonly api: string;
  readonly text: string;
  readonly options?: unknown;
}

export interface FakeVibium {
  readonly module: VibiumModule;
  readonly calls: FakeCall[];
  readonly state: { started: number; stopped: number; recordings: string[]; groups: string[]; aborted: string[] };
}

function glob(pattern: string): RegExp {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${source}$`);
}

const run = (goal: string, status: VibiumRunResult['status'], summary: string, reason?: VibiumRunResult['reason']): VibiumRunResult => ({
  status,
  goal,
  summary,
  ...(reason === undefined ? {} : { reason }),
  evidence: [{ type: 'observation', summary }],
});

const check = (claim: string, status: VibiumCheckResult['status'], summary: string, reason?: VibiumCheckResult['reason']): VibiumCheckResult => ({
  status,
  claim,
  summary,
  ...(reason === undefined ? {} : { reason }),
  evidence: [{ type: 'observation', summary }],
});

/** The judged text only: the claim after the Context block. */
function claimOf(text: string): string {
  const at = text.lastIndexOf('Claim:\n');
  return at === -1 ? text : text.slice(at);
}

function judge(text: string): VibiumCheckResult {
  const claim = claimOf(text);
  if (claim.includes(CONFORMANCE_MARKERS.brokenTotal)) return check(text, 'failed', 'the total shows no discount');
  if (claim.includes('unclear')) return check(text, 'inconclusive', 'the page does not show it either way', 'insufficient_evidence');
  return check(text, 'passed', 'it holds');
}

export interface FakeOptions {
  /** Make `browser.start` throw, as a missing browser does. */
  readonly startFails?: string;
  /** Throw from `page.run`, as a rejected key does. */
  readonly runThrows?: string;
  /** Fail the first N `page.run` calls with `not_completed`, then pass: a flaky agent. */
  readonly flakyRuns?: number;
}

export function fakeVibium(options: FakeOptions = {}): FakeVibium {
  const calls: FakeCall[] = [];
  const state: FakeVibium['state'] = { started: 0, stopped: 0, recordings: [], groups: [], aborted: [] };
  let flaky = options.flakyRuns ?? 0;
  const module: VibiumModule = {
    browser: {
      async start(startOptions) {
        calls.push({ api: 'browser.start', text: '', options: startOptions });
        if (options.startFails !== undefined) throw Object.assign(new Error(options.startFails), { name: 'ConnectionError' });
        state.started += 1;
        const routes: { pattern: RegExp; handler: (route: VibiumRoute) => void }[] = [];
        let recordingPath: string | undefined;
        const send = async (method: string, url: string): Promise<void> => {
          for (const route of routes) {
            if (!route.pattern.test(url)) continue;
            await new Promise<void>((resolve) => {
              route.handler({
                request: { url: () => url, method: () => method },
                abort: async () => {
                  state.aborted.push(`${method} ${url}`);
                  resolve();
                },
                continue: async () => resolve(),
              });
            });
            return;
          }
        };
        const page = {
          context: {
            recording: {
              async start(recordingOptions?: { path?: string | null }) {
                calls.push({ api: 'recording.start', text: '', options: recordingOptions });
                recordingPath = recordingOptions?.path ?? undefined;
              },
              async stop() {
                calls.push({ api: 'recording.stop', text: '' });
                if (recordingPath !== undefined) {
                  mkdirSync(path.dirname(recordingPath), { recursive: true });
                  writeFileSync(recordingPath, 'PK fake recording');
                  state.recordings.push(recordingPath);
                }
                return recordingPath === undefined ? {} : { path: recordingPath };
              },
              async startGroup(name: string) {
                state.groups.push(name);
              },
              async stopGroup() {},
            },
          },
          async go(url: string) {
            calls.push({ api: 'page.go', text: url });
          },
          async route(pattern: string, handler: (route: VibiumRoute) => void) {
            calls.push({ api: 'page.route', text: pattern });
            routes.push({ pattern: glob(pattern), handler });
          },
          async run(goal: string, runOptions?: unknown): Promise<VibiumRunResult> {
            calls.push({ api: 'page.run', text: goal, options: runOptions });
            if (options.runThrows !== undefined) throw new Error(options.runThrows);
            if (flaky > 0) {
              flaky -= 1;
              return run(goal, 'not_completed', 'the page was still loading');
            }
            const task = goal.slice(goal.indexOf('Task:\n'));
            if (task.includes(CONFORMANCE_MARKERS.forbiddenRequest)) {
              await send('POST', 'http://shop.test/api/refund');
              return run(goal, 'completed', 'opened the order; the refund request was sent');
            }
            if (task.includes(CONFORMANCE_MARKERS.refusal)) return run(goal, 'not_completed', 'Stopped: deleting a todo violates guardrail no-delete', 'safety_stop');
            if (task.includes(CONFORMANCE_MARKERS.unreachable)) return run(goal, 'not_completed', 'the wizard has no Billing tab');
            if (task.includes(CONFORMANCE_MARKERS.budget)) return run(goal, 'not_completed', 'ran out of actions dragging', 'action_limit');
            if (task.includes(CONFORMANCE_MARKERS.missingInformation)) return run(goal, 'not_completed', 'no account number was given', 'missing_information');
            return run(goal, 'completed', 'done');
          },
          async check(claim: string, checkOptions?: unknown): Promise<VibiumCheckResult> {
            calls.push({ api: 'page.check', text: claim, options: checkOptions });
            return judge(claim);
          },
        };
        return {
          async page() {
            return page;
          },
          async stop() {
            state.stopped += 1;
          },
        };
      },
      async check(claim, checkOptions) {
        calls.push({ api: 'browser.check', text: claim, options: checkOptions });
        if (!existsSync(checkOptions.record)) return check(claim, 'inconclusive', 'no such archive', 'archive_missing_evidence');
        return judge(claim);
      },
    },
  };
  return { module, calls, state };
}
