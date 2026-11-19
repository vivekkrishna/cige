/**
 * One CIGE case on Vibium. Vibium has no test runner, so the owned loop
 * (`cige run`) opens this session per case:
 *
 * 1. `browser.start()`, then the context's `recording.start({ path })`.
 * 2. One `page.route()` per guardrail `x-deny-requests` entry: a match is
 *    aborted and recorded, so the step it happened in fails as that
 *    guardrail's violation (enforced, not advisory).
 * 3. Each operation in its own recording group, named by its id: an act is
 *    `page.run(goal)`, a verify or an evidence claim `page.check(claim)`.
 * 4. The Intent, judged on the stopped recording (`browser.check(claim,
 *    { record })`), apart from the agent that acted, or live
 *    (`page.check`) with `judge: 'live'`.
 *
 * Vibium has no `agentContext` and no act params, so the case's rendered
 * Context leads every goal and claim, and an act step's values follow its
 * goal: without that, the Context never reaches the model.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { CigeSession, CigeSessionArtifacts, CigeStartContext } from '../../core/contract.ts';
import { CigeError, codedError, isCigeError, signalsForCode } from '../../core/errors.ts';
import { renderAgentContext } from '../../core/render.ts';
import { fillPlaceholders, type CigeCase } from '../../core/schema.ts';
import { checkFailure, runFailure, runnerFailure } from './outcomes.ts';
import type { VibiumCheckResult, VibiumFixtures, VibiumModelOptions, VibiumModule, VibiumRunResult, VibiumStartOptions } from './types.ts';

export interface VibiumSessionOptions {
  readonly start?: VibiumStartOptions;
  readonly model?: VibiumModelOptions;
  /** Model settings per `Context.agent` name. */
  readonly agents?: Readonly<Record<string, VibiumModelOptions>>;
  /** Where the Intent is judged: on the stopped recording (default), or on the live page. */
  readonly judge?: 'archive' | 'live';
  /** The site under test when the environment names none. */
  readonly baseURL?: string;
}

/** A guardrail's `x-deny-requests` entry: an optional method, then a Vibium route pattern. */
export interface DenyRequest {
  readonly guardrail: string;
  readonly rule: string;
  readonly method?: string;
  readonly pattern: string;
}

const METHOD = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)\s+(\S.*)$/i;

/** Every `x-deny-requests` entry of the case's guardrails, and the problems with any that aren't one. */
export function denyRequests(testCase: CigeCase): { readonly rules: DenyRequest[]; readonly problems: string[] } {
  const rules: DenyRequest[] = [];
  const problems: string[] = [];
  for (const guardrail of testCase.guardrails) {
    const value = guardrail.extensions?.['x-deny-requests'];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      problems.push(`guardrail ${guardrail.id}: x-deny-requests must be a list of "[METHOD] <url pattern>" strings`);
      continue;
    }
    for (const entry of value as string[]) {
      const match = METHOD.exec(entry.trim());
      rules.push(
        match === null
          ? { guardrail: guardrail.id, rule: guardrail.rule, pattern: entry.trim() }
          : { guardrail: guardrail.id, rule: guardrail.rule, method: match[1]!.toUpperCase(), pattern: match[2]! },
      );
    }
  }
  return { rules, problems };
}

/** Model settings for the case: the runner's, then its `Context.agent`'s. */
export function modelFor(testCase: CigeCase, options: VibiumSessionOptions): VibiumModelOptions {
  const agent = testCase.context.agent;
  const name = typeof agent === 'string' ? agent : agent?.[0];
  if (name === undefined || name === 'default') return options.model ?? {};
  const pinned = options.agents?.[name];
  if (pinned === undefined) {
    throw new CigeError('TEST_SETUP_FAILED', `Context.agent "${name}" is not one of vibiumRunner's agents (${Object.keys(options.agents ?? {}).join(', ') || 'none'})`);
  }
  return { ...options.model, ...pinned };
}

function valuesBlock(params: Readonly<Record<string, unknown>> | undefined): string {
  if (params === undefined || Object.keys(params).length === 0) return '';
  return ['Values:', ...Object.entries(params).map(([name, value]) => `- ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)].join('\n');
}

function primitives(params: Readonly<Record<string, unknown>> | undefined): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    values[name] = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : JSON.stringify(value);
  }
  return values;
}

/** One case's goal or claim with its Context before it: what the model reads in place of `agentContext`. */
export function withContext(agentContext: string | undefined, label: 'Task' | 'Claim', text: string, extra = ''): string {
  const parts = [...(agentContext === undefined ? [] : [`Context:\n${agentContext}`]), `${label}:\n${text}`, ...(extra === '' ? [] : [extra])];
  return parts.join('\n\n');
}

/** The session's record of what ran, for the summary and plugins' `classify`. */
export interface VibiumNativeRecord {
  readonly runs: { readonly op: string; readonly result: VibiumRunResult }[];
  readonly checks: { readonly op: string; readonly result: VibiumCheckResult }[];
  readonly blocked: { readonly guardrail: string; readonly request: string }[];
}

export async function startVibiumSession(vibium: VibiumModule, context: CigeStartContext, options: VibiumSessionOptions): Promise<CigeSession<VibiumFixtures>> {
  const { testCase } = context;
  const model = modelFor(testCase, options);
  const baseURL = context.environment.baseURL ?? options.baseURL;
  const agentContext = renderAgentContext(testCase, context.plugins);
  const judgeMode = options.judge ?? 'archive';
  const denied = denyRequests(testCase);
  if (denied.problems.length > 0) throw new CigeError('TEST_SETUP_FAILED', denied.problems.join('; '));

  let browser: VibiumFixtures['browser'];
  try {
    browser = await vibium.browser.start({ headless: true, ...options.start });
  } catch (cause) {
    throw runnerFailure(cause, 'browser.start');
  }
  const native: VibiumNativeRecord = { runs: [], checks: [], blocked: [] };
  const groups: string[] = [];
  const recordingPath = path.join(context.outputDir, 'recordings', `${context.name}.attempt-${context.attempt + 1}.zip`);
  let recorded: string | undefined;
  let stopped = false;
  let page: VibiumFixtures['page'];
  try {
    page = await browser.page();
    mkdirSync(path.dirname(recordingPath), { recursive: true });
    await page.context.recording.start({ path: recordingPath, name: context.name, title: testCase.intent.statement, screenshots: true, snapshots: true });
    for (const rule of denied.rules) {
      await page.route(rule.pattern, (route) => {
        const method = route.request.method().toUpperCase();
        if (rule.method !== undefined && method !== rule.method) {
          void route.continue();
          return;
        }
        native.blocked.push({ guardrail: rule.guardrail, request: `${method} ${route.request.url()}` });
        void route.abort();
      });
    }
  } catch (cause) {
    await browser.stop().catch(() => undefined);
    throw isCigeError(cause) ? cause : runnerFailure(cause, 'starting the recording');
  }
  const recording = page.context.recording;
  const stopRecording = async (): Promise<string | undefined> => {
    if (stopped) return recorded;
    stopped = true;
    const result = await recording.stop();
    recorded = result.path ?? recordingPath;
    return recorded;
  };
  const runOptions = { ...model, ...(baseURL === undefined ? {} : { baseURL }) };
  const check = async (op: string, label: string, claim: string, archive?: string): Promise<void> => {
    let result: VibiumCheckResult;
    try {
      result = archive === undefined ? await page.check(claim, runOptions) : await vibium.browser.check(claim, { ...model, record: archive });
    } catch (cause) {
      throw runnerFailure(cause, archive === undefined ? 'page.check' : 'browser.check');
    }
    native.checks.push({ op, result });
    const failure = checkFailure(result, label);
    if (failure !== undefined) throw failure;
  };

  return {
    runner: 'vibium',
    fixtures: { browser, page },
    async open(url) {
      const target = baseURL === undefined ? url : new URL(url, baseURL).href;
      try {
        await page.go(target);
      } catch (cause) {
        throw new CigeError('ENVIRONMENT_UNAVAILABLE', `could not open ${target}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
    },
    async act(op) {
      const values = primitives(op.params);
      const goal = withContext(agentContext, 'Task', fillPlaceholders(op.instruction, values), valuesBlock(op.params));
      const before = native.blocked.length;
      let result: VibiumRunResult;
      try {
        result = await page.run(goal, runOptions);
      } catch (cause) {
        throw runnerFailure(cause, `page.run (${op.id})`);
      }
      native.runs.push({ op: op.id, result });
      const blocked = native.blocked[before];
      if (blocked !== undefined) {
        const rule = testCase.guardrails.find((entry) => entry.id === blocked.guardrail);
        throw new CigeError('POLICY_DENIED', `CIGE guardrail ${blocked.guardrail} violated by request ${blocked.request} (blocked): ${result.summary}. Guardrail: ${rule?.rule ?? ''}`, {
          signals: [{ kind: 'guardrail.violated', detail: blocked.guardrail }],
          native: result,
        });
      }
      const failure = runFailure(result, testCase.guardrails);
      if (failure !== undefined) throw failure;
    },
    async verify(op) {
      await check(op.id, op.phase === 'evidence' ? `CIGE evidence ${op.id}` : `CIGE verify ${op.id}`, withContext(agentContext, 'Claim', op.text));
    },
    async judge(op) {
      const claim = withContext(agentContext, 'Claim', op.text);
      if (judgeMode === 'live') return check(op.id, 'The Intent', claim);
      // Judged apart from the agent that acted: on what the recording holds, after it is closed.
      let archive: string | undefined;
      try {
        archive = await stopRecording();
      } catch (cause) {
        throw runnerFailure(cause, 'recording.stop');
      }
      return check(op.id, 'The Intent', claim, archive);
    },
    async group(op, run) {
      // The archive judge runs on the stopped recording: nothing is left to group it in.
      if (stopped || (op.kind === 'judge' && judgeMode === 'archive')) return run();
      const name = op.kind === 'precondition' ? `precondition:${op.hook}` : op.kind === 'open' ? 'open' : op.id;
      groups.push(name);
      await recording.startGroup(name);
      try {
        return await run();
      } finally {
        await recording.stopGroup().catch(() => undefined);
      }
    },
    failure(code, message, { cause, op }) {
      return new CigeError(code, message, { ...(cause === undefined ? {} : { cause }), signals: signalsForCode(code, op) });
    },
    keeps: (cause) => isCigeError(cause),
    translate(cause) {
      if (isCigeError(cause)) return cause;
      const coded = codedError(cause);
      // An e2e AgentError a shared hook threw keeps its code here too.
      return coded === undefined ? cause : new CigeError(coded.code, coded.message, { cause });
    },
    async stop(): Promise<CigeSessionArtifacts> {
      let path: string | undefined;
      try {
        path = await stopRecording();
      } catch {
        path = undefined;
      }
      await browser.stop().catch(() => undefined);
      return { ...(path === undefined ? {} : { recording: path }), groups, native };
    },
  };
}
