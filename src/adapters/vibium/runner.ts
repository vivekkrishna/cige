/**
 * `vibiumRunner()`: Vibium as a CIGE runner, in owned mode: Vibium has no
 * test runner, so `cige run` owns the loop and opens one session per case.
 * `vibium` is loaded with `import()` only when a case runs on it, so naming
 * this runner in a config costs a project nothing until then.
 */

import type { CigeAvailability, CigeCapabilities, CigeRunner } from '../../core/contract.ts';
import { CigeError } from '../../core/errors.ts';
import { intentAssertion, renderAgentContext } from '../../core/render.ts';
import { installedVersion, isInstalled } from '../../core/select.ts';
import type { CigeOutcome } from '../../core/signals.ts';
import { checkFailure, runnerFailure } from './outcomes.ts';
import { modelFor, startVibiumSession, withContext, type VibiumSessionOptions } from './session.ts';
import type { VibiumFixtures, VibiumModule } from './types.ts';

export const VIBIUM_CAPABILITIES: CigeCapabilities = {
  platforms: ['web'],
  mode: 'owned',
  replay: 'agentic',
  actionEvents: false,
  networkDeny: true,
  archiveJudge: true,
  sessions: false,
};

export interface VibiumRunnerOptions extends VibiumSessionOptions {
  /** Loads Vibium; default `import('vibium')`. Tests pass a scripted stand-in. */
  readonly load?: () => Promise<VibiumModule>;
  /** The version the summaries report, when `load` is a stand-in. */
  readonly version?: string;
  /** Overrides the availability check, for a stand-in that needs no model. */
  readonly available?: () => CigeAvailability;
}

/** The environment variable that holds each provider's key; a provider absent here needs none. */
const PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
};

/**
 * Whether Vibium can run a case now: installed, a provider and model set
 * (in the runner's options, else Vibium's own VIBIUM_AI_PROVIDER and
 * VIBIUM_AI_MODEL), and that provider's key in the environment. These are
 * the errors Vibium would otherwise raise at the first step.
 */
export function vibiumAvailability(options: VibiumRunnerOptions, env: NodeJS.ProcessEnv = process.env): CigeAvailability {
  if (options.load === undefined && !isInstalled('vibium')) return { ok: false, reason: 'vibium is not installed: npm i -D vibium' };
  const provider = options.model?.provider ?? env.VIBIUM_AI_PROVIDER;
  if (provider === undefined || provider === '') return { ok: false, reason: 'no model provider: set model.provider on vibiumRunner, or VIBIUM_AI_PROVIDER' };
  const model = options.model?.model ?? env.VIBIUM_AI_MODEL;
  if (model === undefined || model === '') return { ok: false, reason: `no model for ${provider}: set model.model on vibiumRunner, or VIBIUM_AI_MODEL` };
  const keys = PROVIDER_KEYS[provider];
  if (keys !== undefined && !keys.some((key) => (env[key] ?? '') !== '')) return { ok: false, reason: `${keys.join(' or ')} is not set for ${provider}` };
  return { ok: true };
}

export interface VibiumRunner extends CigeRunner<VibiumFixtures> {
  readonly name: 'vibium';
}

async function loadVibium(): Promise<VibiumModule> {
  try {
    return (await import('vibium')) as unknown as VibiumModule;
  } catch (cause) {
    throw new CigeError('ENVIRONMENT_UNAVAILABLE', `the vibium runner needs vibium installed beside e2e-cige: npm i -D vibium (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
  }
}

export function vibiumRunner(options: VibiumRunnerOptions = {}): VibiumRunner {
  const load = options.load ?? loadVibium;
  let loaded: Promise<VibiumModule> | undefined;
  const vibium = (): Promise<VibiumModule> => (loaded ??= load());
  return {
    name: 'vibium',
    get version() {
      return options.version ?? installedVersion('vibium');
    },
    capabilities: VIBIUM_CAPABILITIES,
    availability: () => options.available?.() ?? vibiumAvailability(options),
    async start(context) {
      return startVibiumSession(await vibium(), context, options);
    },
    async rejudge({ testCase, recording }): Promise<CigeOutcome> {
      const claim = withContext(renderAgentContext(testCase), 'Claim', intentAssertion(testCase));
      let failure: CigeError | undefined;
      try {
        const module = await vibium();
        failure = checkFailure(await module.browser.check(claim, { ...modelFor(testCase, options), record: recording }), 'The Intent');
      } catch (cause) {
        failure = cause instanceof CigeError ? cause : runnerFailure(cause, 'browser.check');
      }
      if (failure === undefined) return { result: 'pass', status: 'passed' };
      return {
        result: 'fail',
        status: 'failed',
        failure: { phase: 'intent', failedStep: 'intent', signals: failure.signals, code: failure.code, message: failure.message },
      };
    },
  };
}
