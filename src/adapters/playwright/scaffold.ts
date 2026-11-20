/**
 * `cige compile`: a case's `*.cige.spec.ts` file, one binding stub per
 * `act` and `verify` step, with the step's goal, its values, and every
 * guardrail written beside it for whoever fills it in (Playwright's
 * generator agent, the `cige` skill, a person). Deterministic text, no model
 * call: the scaffold only says what to write. A stub throws
 * `STEP_NOT_COMPILED` until it is written, so an unfinished spec fails
 * loudly rather than passing.
 */

import path from 'node:path';

import { denyRequests } from '../../core/deny-requests.ts';
import type { CigeCase } from '../../core/schema.ts';

/** The spec file a case's bindings go in: beside the case, `<name>.cige.spec.ts` for `<name>.cige.json`. */
export function specPathFor(caseFile: string): string {
  const dir = path.dirname(caseFile);
  const base = path.basename(caseFile).replace(/\.cige\.json$/i, '').replace(/\.json$/i, '');
  return path.join(dir, `${base}.cige.spec.ts`);
}

/** The import specifier of the CIGE config from the spec's directory: relative, `./` first, with its extension. */
export function configImport(specFile: string, configFile: string): string {
  const relative = path.relative(path.dirname(specFile), configFile).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function comment(text: string, indent: string): string[] {
  return text.split('\n').map((line) => `${indent}// ${line}`.trimEnd());
}

/** A single-quoted string literal. */
function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function key(id: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id) ? id : quote(id);
}

/** The step ids a spec's bindings object names, read from its text: `e1: async`, `'step-1': async`. */
export function boundIds(text: string): string[] {
  return [...text.matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][A-Za-z0-9_$.-]*))\s*:\s*async\b/gm)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

/** One step's stub: its goal or claim, its values, and a body that fails until it is written. */
function stub(testCase: CigeCase, step: CigeCase['execution'][number]): string[] {
  if (step.kind === 'use') return [];
  const values = [...new Set([...Object.keys(testCase.variants[0]?.params ?? {}), ...Object.keys(step.kind === 'act' ? (step.params ?? {}) : {})])];
  return [
    ...comment(`${step.kind === 'act' ? 'Step' : 'Verify'}: ${step.text}`, '  '),
    ...(values.length === 0 ? [] : comment(`Values: ${values.map((name) => `params.${name}`).join(', ')}`, '  ')),
    ...(step.kind === 'verify' ? comment('Check it with expect(): a failed expect here is read as a product defect.', '  ') : []),
    `  ${key(step.id)}: async ({ page${values.length === 0 ? '' : ', params'} }) => {`,
    `    throw new CigeError('STEP_NOT_COMPILED', ${quote(`${step.id} is not compiled yet: write its Playwright code`)});`,
    '  },',
  ];
}

/** The stubs for these step ids only, as lines of a bindings object: what `compile` prints for a spec that exists. */
export function renderStubs(testCase: CigeCase, ids: readonly string[]): string {
  return testCase.execution.filter((step) => ids.includes(step.id)).flatMap((step) => stub(testCase, step)).join('\n');
}

/** The whole spec file for a case. `importPath` is the CIGE config's specifier from the spec. */
export function renderSpec(testCase: CigeCase, importPath: string): string {
  const { rules } = denyRequests(testCase);
  const guardrails = testCase.guardrails.flatMap((rule) => {
    const blocked = rules.filter((entry) => entry.guardrail === rule.id).map((entry) => `${entry.method ?? 'any'} ${entry.pattern}`);
    return [
      `// - [${rule.id}] ${rule.rule}`,
      ...(blocked.length === 0 ? [] : [`//   Enforced: requests to ${blocked.join(', ')} are blocked, and the step that sends one fails.`]),
    ];
  });
  const source = testCase.file === undefined ? testCase.id : path.basename(testCase.file);
  const usedSteps = testCase.execution.filter((step) => step.kind === 'use').map((step) => `${step.id} (${step.use})`);
  return [
    `// The Execution of ${source} as Playwright code: one binding per step.`,
    '// Rewrite a binding when the flow changes; that is what Execution is for.',
    "// What a pass means stays in the case and cige.config.ts, where `cige diff` guards it:",
    '// the Intent, the Guardrails, and the evidence. Never weaken a verify to make it pass.',
    `// Intent: ${testCase.intent.statement.split('\n')[0]}`,
    ...(guardrails.length === 0 ? [] : ['//', '// Guardrails: every binding must keep to them; no agent reads them here.', ...guardrails]),
    ...(usedSteps.length === 0 ? [] : ['//', `// Plugin steps run by their plugin, not here: ${usedSteps.join(', ')}.`]),
    '',
    "import { expect } from '@playwright/test';",
    "import { CigeError, cigeTest } from 'e2e-cige/playwright';",
    '',
    `import config from ${quote(importPath)};`,
    '',
    `cigeTest(config, ${quote(testCase.id)}, {`,
    ...testCase.execution.flatMap((step) => stub(testCase, step)),
    '});',
    '',
  ].join('\n');
}
