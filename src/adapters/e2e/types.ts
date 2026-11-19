/**
 * The core types with e2e's filled in, so an e2e project types its hooks,
 * plugins, and config against its test fixtures and report without saying so.
 */

import type { ActionEvent, Report, TestFixtures } from 'e2e';

import type { CigeConfig as CoreConfig } from '../../core/config.ts';
import type { CigePlugin as CorePlugin, CigeStepContext as CoreStepContext, CigeStepRunner as CoreStepRunner } from '../../core/plugins.ts';

export type CigeConfig<Fixtures = TestFixtures> = CoreConfig<Fixtures>;

/** A plugin on e2e: `classify` gets the report result, `onAction` e2e's action event. */
export type CigePlugin<Fixtures = TestFixtures> = CorePlugin<Fixtures, Report['run']['results'][number], ActionEvent>;

export type CigeStepContext<Fixtures = TestFixtures> = CoreStepContext<Fixtures>;

export type CigeStepRunner<Fixtures = TestFixtures> = CoreStepRunner<Fixtures>;

/** Declares the CIGE config, typed for e2e's fixtures. Export it as the default of `cige.config.ts`. */
export function defineCige<Fixtures extends TestFixtures = TestFixtures>(config: CigeConfig<Fixtures>): CigeConfig<Fixtures> {
  return config;
}
