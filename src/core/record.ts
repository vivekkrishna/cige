/**
 * The neutral run record: one result of one resolved case, whichever runner
 * produced it. A hosted adapter builds records from its runner's report; an
 * owned run builds them as it goes. The summary writer reads nothing else.
 */

import type { CigeRunnerSelection } from './contract.ts';
import type { CigeCase } from './schema.ts';
import type { CigeOutcome } from './signals.ts';

export interface CigeRunRecord {
  /** The case id and variant the result is for. */
  readonly key: { readonly id: string; readonly variant?: string };
  /** The name its summary file is written under (before it is made file-safe). */
  readonly name: string;
  readonly runner: { readonly name: string; readonly version: string; readonly selected?: CigeRunnerSelection };
  /** The resolved case; undefined when its file is no longer among the globs. */
  readonly testCase: CigeCase | undefined;
  readonly outcome: CigeOutcome;
  /** The title the runner gave the result, for a case no longer found. */
  readonly title?: string;
  /** `YYYY-MM-DD` the run started. */
  readonly runDate: string;
  readonly target: string;
  readonly agent: string;
  readonly attempts: number;
  /** A `--last-failed` rerun carried it without running it again. */
  readonly carried: boolean;
  /** Replay options that pick this result out when the case ran more than once (`--target`, `--agent`). */
  readonly narrow: readonly string[];
  readonly evidence: {
    readonly report?: string;
    readonly resultId: string;
    readonly trace?: string;
    readonly artifacts: readonly string[];
    /** A recording an archive judge can read, project-relative. */
    readonly recording?: string;
    /** The groups in it, one per operation that ran. */
    readonly groups?: readonly string[];
  };
  /** The runner's native result: e2e's report result, Vibium's per-case record. */
  readonly native?: unknown;
}
