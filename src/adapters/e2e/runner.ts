/**
 * `e2eRunner()`: e2e as a CIGE runner. e2e hosts the loop: `cigeSuite`
 * registers the cases as its tests, and the `cige()` reporter reads its
 * report back, so this factory only names the runner, what it can do, and
 * the e2e config the cases run under. It imports nothing of e2e, so a
 * config can name it before e2e is installed; `cige run --runner e2e`
 * hands the run to `e2e run`.
 */

import type { CigeCapabilities, CigeRunner } from '../../core/contract.ts';
import { installedVersion, isInstalled } from '../../core/select.ts';

export const E2E_CAPABILITIES: CigeCapabilities = {
  // e2e runs whatever platform its targets declare; a target that doesn't match skips the case.
  platforms: ['*'],
  mode: 'hosted',
  replay: 'deterministic',
  actionEvents: true,
  networkDeny: false,
  archiveJudge: false,
  sessions: true,
};

export interface E2eRunnerOptions {
  /** The e2e config file the cases run under, when it isn't the nearest `e2e.config.ts`. */
  readonly config?: string;
}

export interface E2eRunner extends CigeRunner {
  readonly name: 'e2e';
  readonly config?: string;
}

export function e2eRunner(options: E2eRunnerOptions = {}): E2eRunner {
  return {
    name: 'e2e',
    get version() {
      return installedVersion('e2e');
    },
    capabilities: E2E_CAPABILITIES,
    // Its model lives in the e2e config, which only e2e reads; installed is what can be known here.
    availability: () => (isInstalled('e2e') ? { ok: true } : { ok: false, reason: 'e2e is not installed: npm i -D e2e' }),
    ...(options.config === undefined ? {} : { config: options.config }),
  };
}
