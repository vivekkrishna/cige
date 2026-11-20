/**
 * A guardrail's `x-deny-requests`: requests the runner blocks, as a list of
 * `"[METHOD] <url pattern>"` strings. A runner that can route requests
 * (`networkDeny`: Vibium's `page.route`, Playwright's `context.route`) aborts
 * each match and fails the step it happened in as that guardrail's
 * violation, so the rule is enforced rather than advised.
 */

import type { CigeCase } from './schema.ts';

/** A guardrail's `x-deny-requests` entry: an optional method, then a route pattern. */
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
