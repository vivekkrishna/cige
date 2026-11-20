/**
 * `cige healer`: the CIGE rule, added to the healer agent `npx playwright
 * init-agents` generates. That agent fixes any failing test, "assertions and
 * expected values" included, and marks one it can't fix `test.fixme()`: on
 * a product defect, both hide the bug. The block makes it read the run
 * summary first and repair only what the failure type allows. It sits
 * between markers, so running the command again replaces it rather than
 * adding a second copy.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const HEALER_BEGIN = '<!-- cige:begin -->';
export const HEALER_END = '<!-- cige:end -->';

/** Where `npx playwright init-agents` writes the healer, per agent loop. */
const HEALER_DIRS = ['.claude/agents', '.github/agents', '.github/chatmodes', '.opencode/prompts'];

/** The rule the healer follows for a CIGE test. `summaries` is where the run summaries are, from the project root. */
export function healerBlock(summaries = '.e2e/cige'): string {
  return `${HEALER_BEGIN}
## CIGE tests: classify before you heal

A test tagged \`@cige\` is a CIGE case. Its \`.cige.json\` file says what the test proves (Intent), what it must
never do (Guardrails), and what counts as proof (evidence). Its \`.cige.spec.ts\` file holds the Playwright code
for each step (Execution). Only the Execution may change to make it pass again.

Before you change a failing \`@cige\` test:

1. Read its run summary, \`${summaries}/<id>.run-summary.json\` (the failure message names it too), and act on
   \`failureType\`:
   - \`outdated-test-logic\`: the flow changed. Repair the binding of \`failedStep\` in the \`.cige.spec.ts\` file:
     a selector, a wait, the order of actions. This is the only failure you may fix by editing the test.
   - \`product-defect\`: the app contradicts the Intent. Do not change the test, its expected values, or its
     assertions, and do not mark it \`test.fixme()\`. Do not edit the application's code either: fixing the
     product is not a healer's job. Stop and report the defect with the summary's message and where you think
     the bug is.
   - \`infrastructure\`: the environment was not ready. Do not change the test or the app. Report what was not
     ready; whoever runs the suite restores the environment (\`npx cige env reset <environment>\`).
   - No \`failureType\`: do not edit anything yet. Read \`classification.signals\` and the trace. A
     \`guardrail-violation:<id>\` means the path now sends a request a guardrail forbids: never loosen or route
     around the guardrail, and report it.
2. Never edit a \`.cige.json\` file, \`cige.config.ts\`, or the hooks it imports, and never weaken a \`verify\`
   binding's \`expect\` to make it pass. \`npx cige diff\` blocks such changes for a human to approve.
3. After a repair, run that case's tests again (grep \`@cige:<id>\`) and confirm they pass. If you have a shell,
   also run \`npx cige diff --json\` and confirm \`intentUnchanged\` is true.
${HEALER_END}`;
}

/** The healer agent files under `cwd` that `npx playwright init-agents` wrote. */
export function healerFiles(cwd: string): string[] {
  return HEALER_DIRS.flatMap((dir) => {
    const absolute = path.join(cwd, dir);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute)
      .filter((name) => /healer/i.test(name) && /\.md$/i.test(name))
      .map((name) => path.join(absolute, name));
  }).toSorted();
}

/** The file's text with the block in it: replacing an earlier block, else appended. */
export function withHealerBlock(text: string, block: string): string {
  const begin = text.indexOf(HEALER_BEGIN);
  const end = text.indexOf(HEALER_END);
  if (begin !== -1 && end > begin) return `${text.slice(0, begin)}${block}${text.slice(end + HEALER_END.length)}`;
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

/** Writes the block into one healer file; true when the file changed. */
export function installHealerBlock(file: string, block: string): boolean {
  const before = readFileSync(file, 'utf8');
  const after = withHealerBlock(before, block);
  if (after === before) return false;
  writeFileSync(file, after);
  return true;
}
