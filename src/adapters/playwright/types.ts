/**
 * The types a Playwright Test project writes against: the fixtures hooks and
 * bindings get, a binding itself, and the optional model judge. Type-only
 * imports of `@playwright/test`, so importing this module loads nothing.
 */

import type { APIRequestContext, Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

import type { CigeConfig as CoreConfig } from '../../core/config.ts';
import type { CigePlugin as CorePlugin } from '../../core/plugins.ts';
import type { CigeCase, CigeExecutionStep } from '../../core/schema.ts';

/** What a hook, a plugin's step, and a binding get: the test's Playwright fixtures. */
export interface CigePlaywrightFixtures {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly request: APIRequestContext;
  readonly browser: Browser;
  readonly testInfo: TestInfo;
  /** The site under test: the environment's `baseURL`, else the runner's, else Playwright's `use.baseURL`. */
  readonly baseURL: string | undefined;
}

/** An `act` or `verify` step of the case. */
export type CigeBoundStep = Extract<CigeExecutionStep, { readonly kind: 'act' | 'verify' }>;

/** What a binding runs with: the fixtures, the step it is for, and the values this run uses. */
export interface CigeBindingArgs extends CigePlaywrightFixtures {
  /** The resolved case: a variant's values filled in. */
  readonly testCase: CigeCase;
  readonly step: CigeBoundStep;
  /** The variant's values, then the step's own `params`. Empty without either. */
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * One Execution step as Playwright code. An `act` binding reaches the step's
 * goal; a `verify` binding checks its claim with `expect`. Resolve to pass;
 * throw to fail. What a throw means is read from the error, so let
 * Playwright's own errors through: a locator that finds nothing is a stale
 * path, an `expect` that fails in a `verify` is a defect.
 */
export type CigeBinding = (args: CigeBindingArgs) => unknown;

/** Every `act` and `verify` step of one case, by step id. */
export type CigeBindings = Readonly<Record<string, CigeBinding>>;

/** What a model judge is asked: one claim, about the page as it is now. */
export interface CigeJudgeInput {
  /** The Intent with its criteria, or an evidence item's claim. */
  readonly claim: string;
  readonly kind: 'intent' | 'evidence';
  /** `intent`, or the evidence item's id. */
  readonly id: string;
  /** The case's Context as the model reads it (`renderAgentContext`), when it has one. */
  readonly context: string | undefined;
  readonly testCase: CigeCase;
  readonly page: Page;
  readonly testInfo: TestInfo;
}

export interface CigeJudgeVerdict {
  readonly status: 'passed' | 'failed' | 'inconclusive';
  /** Why, in a sentence: it goes into the failure message and the run summary. */
  readonly summary?: string;
}

/**
 * A model judge, for an Intent judged on the screen (`"judge"` on) and for
 * evidence `assert` items. Your code, in `cige.config.ts`, where `cige diff`
 * guards it: a repair can't loosen it. Throw when the model can't be reached.
 */
export type CigeJudge = (input: CigeJudgeInput) => CigeJudgeVerdict | Promise<CigeJudgeVerdict>;

/** The CIGE config, typed for Playwright's fixtures. */
export type CigeConfig = CoreConfig<CigePlaywrightFixtures>;

/** A plugin on Playwright: `classify` gets the test's result record. */
export type CigePlugin = CorePlugin<CigePlaywrightFixtures>;
