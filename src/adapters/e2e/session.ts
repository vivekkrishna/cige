/**
 * The e2e session: a test's fixtures as a CIGE session. Each operation is
 * one e2e call (`app.open`, `agent.act`, `agent.assert`), and a failure is
 * e2e's own `AgentError`, so the report records it exactly as e2e always
 * has and the reporter reads it back from there.
 */

import { AgentError, isAgentError, type ActionEvent, type ActOptions, type AgentParams, type TestFixtures } from 'e2e';
import { isE2EError } from 'e2e/runner';

import type { CigeSession } from '../../core/contract.ts';
import { isCigeError } from '../../core/errors.ts';
import { servesRunner, type AnyPlugin, type CigeGuardrailViolation } from '../../core/plugins.ts';
import type { CigeCase } from '../../core/schema.ts';
import { createGuardrailMonitor } from './guardrails.ts';

type AgentErrorCode = AgentError['code'];

/** The `CigeError` codes that are e2e agent codes, so a runner-neutral hook's throw keeps its code here. */
const AGENT_CODES: ReadonlySet<string> = new Set<AgentErrorCode>([
  'ENVIRONMENT_UNAVAILABLE',
  'TEST_SETUP_FAILED',
  'ASSERTION_FAILED',
  'ASSERTION_INCONCLUSIVE',
  'ACTION_FAILED',
  'LOCATOR_NOT_FOUND',
  'LOCATOR_AMBIGUOUS',
  'POLICY_DENIED',
]);

/** The e2e plugins' `onAction` checks as one, or undefined when no plugin has one. */
function pluginCheck(plugins: readonly AnyPlugin[], testCase: CigeCase): ((event: ActionEvent) => CigeGuardrailViolation | undefined) | undefined {
  const checks = plugins.flatMap((plugin) => (plugin.onAction === undefined || !servesRunner(plugin, 'e2e') ? [] : [plugin.onAction]));
  if (checks.length === 0) return undefined;
  return (event) => {
    for (const check of checks) {
      const violation = check(event, testCase);
      if (violation !== undefined) return violation;
    }
    return undefined;
  };
}

/** One resolved case's session on a test's fixtures. */
export function e2eSession<Fixtures extends TestFixtures>(testCase: CigeCase, fixtures: Fixtures, plugins: readonly AnyPlugin[] = []): CigeSession<Fixtures> {
  const { agent, app } = fixtures;
  const onAction = createGuardrailMonitor(testCase.guardrails, pluginCheck(plugins, testCase));
  return {
    runner: 'e2e',
    fixtures,
    async open(url) {
      await app.open(url);
    },
    async act(op) {
      const options: ActOptions = {
        ...(op.params === undefined ? {} : { params: op.params as AgentParams }),
        ...(onAction === undefined ? {} : { onAction }),
      };
      await agent.act(op.instruction, options);
    },
    async verify(op) {
      await agent.assert(op.text, op.vision === true ? { vision: true } : {});
    },
    async judge(op) {
      await agent.assert(op.text);
    },
    failure(code, message, { cause }) {
      return new AgentError(code as AgentErrorCode, message, ...(cause === undefined ? [] : [{ cause }]));
    },
    // A precondition keeps only an agent error's code; a step kind or evidence hook keeps any e2e error's.
    keeps: (cause, site) => (site === 'precondition' ? isAgentError(cause) : isE2EError(cause)),
    translate: (cause) => (isCigeError(cause) && AGENT_CODES.has(cause.code) ? new AgentError(cause.code as AgentErrorCode, cause.message, { cause }) : cause),
  };
}
