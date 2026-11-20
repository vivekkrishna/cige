/**
 * `e2e-cige/playwright`: CIGE on Playwright Test. `cigeTest` in a
 * `*.cige.spec.ts` file registers a case as Playwright tests with its steps
 * bound to Playwright code, `e2e-cige/playwright/reporter` writes the run
 * summaries, and `playwrightRunner` names Playwright as a runner in the CIGE
 * config, with the optional model judge and the saved sessions.
 */

export { cigeTest, bindingProblems, playwrightOf, type CigeTestOptions } from './suite.ts';
export {
  playwrightRunner,
  playwrightCli,
  specsBinding,
  needsJudge,
  rootOf,
  DEFAULT_SPECS,
  PLAYWRIGHT_CAPABILITIES,
  type PlaywrightRunner,
  type PlaywrightRunnerOptions,
} from './runner.ts';
export { playwrightFailure, plainMessage, isExpectFailure } from './errors.ts';
export { startPlaywrightSession, stepTitle, opIdOfTitle, type BlockedRequest, type PlaywrightSession, type PlaywrightSessionOptions } from './session.ts';
export { appendVerdict, classifyFailure, failureOf, verdictLine, OUTCOME_ATTACHMENT } from './verdict.ts';
export { caseOfTags, failureOfResult, outcomeOfResult, type CigePlaywrightReporterOptions } from './reporter.ts';
export type {
  CigeBinding,
  CigeBindingArgs,
  CigeBindings,
  CigeBoundStep,
  CigeConfig,
  CigeJudge,
  CigeJudgeInput,
  CigeJudgeVerdict,
  CigePlaywrightFixtures,
  CigePlugin,
} from './types.ts';
export { CigeError } from '../../core/errors.ts';
export { defineCige } from '../../core/config.ts';
