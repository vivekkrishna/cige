/**
 * `playwrightRunner()`: Playwright Test as a CIGE runner, hosted like e2e.
 * Playwright's own runner owns the loop: `cigeTest` in a `*.cige.spec.ts`
 * file registers a case as a `test()` with its steps bound to Playwright
 * code, and the `e2e-cige/playwright/reporter` reporter writes the run
 * summaries. This factory names the runner, what it can do, the options the
 * spec and reporter read (the judge, the saved sessions), and how `cige run`
 * starts `playwright test`. It imports nothing of Playwright, so a config can
 * name it before `@playwright/test` is installed.
 */

import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CigeCapabilities, CigeLaunch, CigeLaunchRequest, CigeRunner, CigeRunnerReadiness } from '../../core/contract.ts';
import { denyRequests } from '../../core/deny-requests.ts';
import type { CigeRoot } from '../../core/load.ts';
import type { CigeCase } from '../../core/schema.ts';
import { installedVersion, isInstalled, PLAYWRIGHT_PACKAGE } from '../../core/select.ts';
import { cigeGrep } from '../../core/tags.ts';
import type { CigeJudge, CigePlaywrightFixtures } from './types.ts';

export const PLAYWRIGHT_CAPABILITIES: CigeCapabilities = {
  platforms: ['web'],
  mode: 'hosted',
  // Bound code: a rerun repeats the same path, and no model call makes it.
  replay: 'deterministic',
  // No agent acts, so nothing reports per-action events for `deny` rules.
  actionEvents: false,
  // `context.route()` aborts what `x-deny-requests` forbids.
  networkDeny: true,
  archiveJudge: false,
  // `Context.session` names a storageState file in `sessions`.
  sessions: true,
  agents: false,
};

/** The spec files `cigeTest` registers cases from, unless the runner names others. */
export const DEFAULT_SPECS: readonly string[] = ['**/*.cige.spec.ts', '**/*.cige.spec.mts', '**/*.cige.spec.js', '**/*.cige.spec.mjs'];

export interface PlaywrightRunnerOptions {
  /** The Playwright config the cases run under, when it isn't the nearest `playwright.config.ts`. */
  readonly config?: string;
  /**
   * The model judge for an Intent judged on the screen and for evidence
   * `assert` items. Without one, a case must set `"judge": false` and prove
   * its Intent with hook evidence.
   */
  readonly judge?: CigeJudge;
  /** A storageState file per `Context.session` name, relative to the CIGE config's directory. */
  readonly sessions?: Readonly<Record<string, string>>;
  /** Globs of the spec files that bind the cases, against the CIGE config's root; default every `*.cige.spec.ts`. */
  readonly specs?: string | readonly string[];
  /** The site under test when the case's environment names none; else Playwright's `use.baseURL`. */
  readonly baseURL?: string;
}

export interface PlaywrightRunner extends CigeRunner<CigePlaywrightFixtures> {
  readonly name: 'playwright';
  readonly config?: string;
  readonly judge?: CigeJudge;
  readonly sessions?: Readonly<Record<string, string>>;
  readonly specs: readonly string[];
  readonly baseURL?: string;
}

/** The directory the config's globs resolve against: its `root`, else the working directory, as `cigeSuite` reads it. */
export function rootOf(root: CigeRoot | undefined): string {
  if (root === undefined) return process.cwd();
  return root instanceof URL ? fileURLToPath(root) : path.resolve(root);
}

/** Whether a case needs a judge on Playwright: an Intent judged on the screen, or an evidence `assert` item. */
export function needsJudge(testCase: CigeCase): boolean {
  return testCase.intent.judge || testCase.intent.evidence.some((item) => item.kind === 'assert');
}

/** The text of every spec file under `root`. Read afresh on each call: `cige compile` writes them. */
function specsUnder(root: string, globs: readonly string[]): readonly { readonly file: string; readonly text: string }[] {
  const files = [...new Set(globSync([...globs], { cwd: root, exclude: (name) => path.basename(name) === 'node_modules' }).map((match) => path.resolve(root, match)))].toSorted();
  return files.flatMap((file) => {
    try {
      return statSync(file).isFile() ? [{ file, text: readFileSync(file, 'utf8') }] : [];
    } catch {
      return [];
    }
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The spec files whose `cigeTest(config, '<id>', ...)` binds the case, by a scan of their text: nothing is imported. */
export function specsBinding(id: string, root: string, globs: readonly string[] = DEFAULT_SPECS): string[] {
  const call = new RegExp(`cigeTest\\s*\\(\\s*[^,()]+,\\s*(['"\`])${escapeRegExp(id)}\\1`);
  return specsUnder(root, globs)
    .filter(({ text }) => call.test(text))
    .map(({ file }) => file);
}

/** The `playwright` command the installed `@playwright/test` declares, found from the project, run with this Node. */
export function playwrightCli(cwd: string): string {
  const require = createRequire(path.join(cwd, 'package.json'));
  let manifest: string;
  try {
    manifest = require.resolve(`${PLAYWRIGHT_PACKAGE}/package.json`);
  } catch {
    throw new Error(`cannot find ${PLAYWRIGHT_PACKAGE} from ${cwd}; install it beside e2e-cige: npm i -D ${PLAYWRIGHT_PACKAGE}`);
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.playwright;
  const script = path.resolve(path.dirname(manifest), bin ?? 'cli.js');
  if (!existsSync(script)) throw new Error(`${PLAYWRIGHT_PACKAGE} declares no playwright command at ${script}`);
  return script;
}

export function playwrightRunner(options: PlaywrightRunnerOptions = {}): PlaywrightRunner {
  const specs = options.specs === undefined ? DEFAULT_SPECS : typeof options.specs === 'string' ? [options.specs] : [...options.specs];
  return {
    name: 'playwright',
    get version() {
      return installedVersion(PLAYWRIGHT_PACKAGE);
    },
    capabilities: PLAYWRIGHT_CAPABILITIES,
    availability: () => (isInstalled(PLAYWRIGHT_PACKAGE) ? { ok: true } : { ok: false, reason: `${PLAYWRIGHT_PACKAGE} is not installed: npm i -D ${PLAYWRIGHT_PACKAGE}` }),
    readiness(testCase, { root }): CigeRunnerReadiness {
      const blocking: string[] = [];
      const advisory: string[] = [];
      if (specsBinding(testCase.id, root, specs).length === 0) {
        blocking.push(`no spec binds its steps: write one with npx cige compile ${testCase.id} (cigeTest(config, '${testCase.id}', {...}) in a ${specs[0]} file)`);
      }
      if (needsJudge(testCase) && options.judge === undefined) {
        blocking.push('it is judged on the screen (the Intent, or an evidence assert), and playwrightRunner has no judge: set judge, or prove the Intent with hook evidence and "judge": false');
      }
      const sessions = [testCase.context.session, ...testCase.variants.map((variant) => variant.session)].filter((name) => name !== undefined);
      for (const name of new Set(sessions)) {
        if (options.sessions === undefined || !Object.hasOwn(options.sessions, name)) blocking.push(`Context.session "${name}" has no storageState file in playwrightRunner's sessions`);
      }
      const { problems } = denyRequests(testCase);
      blocking.push(...problems);
      if (testCase.context.requires !== undefined) advisory.push('playwright matches no targets by capability (Context.requires): it is ignored; use Playwright projects');
      return { blocking, advisory };
    },
    launch(request: CigeLaunchRequest): CigeLaunch {
      const script = playwrightCli(request.cwd);
      const args = [
        'test',
        ...(options.config === undefined ? [] : ['--config', options.config]),
        '--grep',
        cigeGrep(request.tags),
        ...(request.lastFailed === true ? ['--last-failed'] : []),
        ...(request.workers === undefined ? [] : ['--workers', String(request.workers)]),
        ...(request.replay === true ? ['--retries', '0'] : request.retries === undefined ? [] : ['--retries', String(request.retries)]),
        ...request.passthrough,
      ];
      return { script, args, display: `playwright ${args.join(' ')}` };
    },
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.judge === undefined ? {} : { judge: options.judge }),
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    specs,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  };
}
