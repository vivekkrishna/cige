/**
 * Readiness: what a classifier or a repair would be missing if a case
 * failed now. A failure can be told apart from an intended change only
 * against the spec and the build's release notes, and replayed only in an
 * environment that can be reset, so a gap here is found on day one instead
 * of in the middle of triage. `cige check` lists every gap; the
 * reporter counts them under the run summary.
 */

import type { CigeConfig } from './config.ts';
import type { CigeCapabilities } from './contract.ts';
import { missingStepKinds, servesRunner } from './plugins.ts';
import type { CigeCase } from './schema.ts';

/** One thing a case lacks for classification or replay. */
export type CigeGapKind =
  | 'no-spec-ref'
  | 'no-build-ref'
  | 'build-unset'
  | 'environment-unset'
  | 'environment-undeclared'
  | 'environment-no-reset'
  | 'resolver-failed'
  | 'plugin'
  | 'runner';

export interface CigeGap {
  readonly kind: CigeGapKind;
  readonly detail: string;
  /** The plugin whose `readiness` hook reported it, for a `plugin` gap. */
  readonly plugin?: string;
  /** The runner it is a gap on, for a `runner` gap. */
  readonly runner?: string;
}

/**
 * What a case needs that a runner can't give it: a platform it doesn't run,
 * a saved session it can't restore, a step kind no plugin registers for it,
 * and a guardrail rule it can only pass to the agent as text, never enforce.
 */
export function capabilityGaps<Fixtures>(
  testCase: CigeCase,
  runner: { readonly name: string; readonly capabilities: CigeCapabilities },
  config: Pick<CigeConfig<Fixtures>, 'plugins'>,
): CigeGap[] {
  const { name, capabilities } = runner;
  const gaps: CigeGap[] = [];
  const gap = (detail: string): void => {
    gaps.push({ kind: 'runner', runner: name, detail });
  };
  const platforms = [...(testCase.context.platforms ?? []), ...testCase.variants.flatMap((variant) => variant.platforms ?? [])];
  const unsupported = capabilities.platforms.includes('*') ? [] : [...new Set(platforms)].filter((platform) => !capabilities.platforms.includes(platform));
  if (unsupported.length > 0) gap(`${name} runs ${capabilities.platforms.join(', ')}, not ${unsupported.join(', ')}: those runs are skipped`);
  if (!capabilities.sessions && (testCase.context.session !== undefined || testCase.variants.some((variant) => variant.session !== undefined))) {
    gap(`${name} can't restore a saved session (Context.session): the case starts signed out`);
  }
  if (testCase.context.requires !== undefined && capabilities.mode === 'owned') gap(`${name} doesn't match targets by capability (Context.requires): it is ignored`);
  for (const kind of missingStepKinds(testCase, config.plugins ?? [], name)) gap(`no plugin registers step kind "${kind}" for ${name}; set the plugin's runners`);
  if (!capabilities.actionEvents) {
    const advisory = testCase.guardrails.filter((rule) => rule.deny !== undefined).map((rule) => rule.id);
    if (advisory.length > 0) gap(`${name} reports no per-action events, so the deny rules of ${advisory.join(', ')} are advisory: the agent reads them, nothing enforces them`);
    const checks = (config.plugins ?? []).filter((plugin) => plugin.onAction !== undefined && servesRunner(plugin, name)).map((plugin) => plugin.name);
    if (checks.length > 0) gap(`${name} reports no per-action events, so the onAction checks of ${checks.join(', ')} never run`);
  }
  if (!capabilities.networkDeny) {
    const advisory = testCase.guardrails.filter((rule) => rule.extensions?.['x-deny-requests'] !== undefined).map((rule) => rule.id);
    if (advisory.length > 0) gap(`${name} can't block requests, so the x-deny-requests of ${advisory.join(', ')} are advisory`);
  }
  return gaps;
}

const BUILD_PLACEHOLDER = /\{build\}/;
const ENVIRONMENT_PLACEHOLDER = /\{environment\}/;

/** Every gap one case has under the config, in a fixed order; empty when it is ready. */
export function readinessGaps<Fixtures>(testCase: CigeCase, config: Pick<CigeConfig<Fixtures>, 'build' | 'refs' | 'environments' | 'plugins'>): CigeGap[] {
  const { context } = testCase;
  const gaps: CigeGap[] = [];
  if (context.specRef === undefined && config.refs?.spec === undefined) {
    gaps.push({ kind: 'no-spec-ref', detail: 'no Context.specRef and no refs.spec resolver: a failure cannot be checked against the spec' });
  }
  if (context.buildRef === undefined && config.refs?.build === undefined) {
    gaps.push({ kind: 'no-build-ref', detail: 'no Context.buildRef and no refs.build resolver: a spec change cannot be confirmed as shipped' });
  }
  const refs = [context.specRef, context.buildRef, context.expectedRef].filter((ref) => ref !== undefined);
  if (refs.some((ref) => BUILD_PLACEHOLDER.test(ref)) && config.build === undefined) {
    gaps.push({ kind: 'build-unset', detail: 'a ref uses {build}, but the config sets no build; pass the CI commit or release tag' });
  }
  const environment = context.environment;
  if (environment === undefined) {
    if (refs.some((ref) => ENVIRONMENT_PLACEHOLDER.test(ref))) {
      gaps.push({ kind: 'environment-unset', detail: 'a ref uses {environment}, but the case sets no Context.environment' });
    } else if (config.environments !== undefined) {
      gaps.push({ kind: 'environment-unset', detail: 'no Context.environment: a replay has no environment to reset' });
    }
  } else {
    const declared = config.environments === undefined || !Object.hasOwn(config.environments, environment) ? undefined : config.environments[environment];
    if (declared === undefined) {
      gaps.push({ kind: 'environment-undeclared', detail: `environment "${environment}" is not in the config's environments: a replay cannot reset it` });
    } else if (declared.reset === undefined) {
      gaps.push({ kind: 'environment-no-reset', detail: `environment "${environment}" has no reset action: recovery cannot restore it` });
    }
  }
  for (const plugin of config.plugins ?? []) {
    if (plugin.readiness === undefined) continue;
    try {
      const details = plugin.readiness(testCase) ?? [];
      for (const detail of typeof details === 'string' ? [details] : details) gaps.push({ kind: 'plugin', plugin: plugin.name, detail });
    } catch (cause) {
      gaps.push({ kind: 'plugin', plugin: plugin.name, detail: `the readiness check failed: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
  }
  return gaps;
}
