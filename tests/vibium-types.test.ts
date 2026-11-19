/**
 * The adapter's structural types for Vibium (`src/adapters/vibium/types.ts`)
 * against the real ones in the pinned devDependency: a renamed method or a
 * new result status in Vibium fails typecheck here.
 */

import { describe, expect, it } from 'vitest';
import type * as Vibium from 'vibium';

import type { VibiumCheckResult, VibiumModule, VibiumRunResult } from '../src/adapters/vibium/types.ts';

// Compile-time only: each assignment holds the real type to the structural one.
export const asModule = (module: typeof Vibium): VibiumModule => module;
export const asRun = (result: Vibium.RunResult): VibiumRunResult => result;
export const asCheck = (result: Vibium.CheckResult): VibiumCheckResult => result;
// And back: every status and reason the adapter maps is one Vibium can return.
export const fromRun = (result: VibiumRunResult): Vibium.RunResult => ({ ...result, evidence: [...result.evidence] });
export const fromCheck = (result: VibiumCheckResult): Vibium.CheckResult => ({ ...result, evidence: [...result.evidence] });

describe('vibium types', () => {
  it('match the installed vibium (checked by tsc)', () => {
    expect(typeof asModule).toBe('function');
  });
});
