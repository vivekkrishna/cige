/**
 * `e2e-cige/vibium`: CIGE on Vibium. `vibiumRunner()` names Vibium as a
 * runner in the CIGE config; `cige run --runner vibium` runs the cases.
 * Nothing here imports `vibium` until a case runs on it.
 */

export { vibiumAvailability, vibiumRunner, VIBIUM_CAPABILITIES, type VibiumRunner, type VibiumRunnerOptions } from './runner.ts';
export { denyRequests, withContext, type DenyRequest, type VibiumNativeRecord, type VibiumSessionOptions } from './session.ts';
export type {
  VibiumBrowser,
  VibiumCheckResult,
  VibiumFixtures,
  VibiumModelOptions,
  VibiumModule,
  VibiumPage,
  VibiumRecording,
  VibiumRoute,
  VibiumRunResult,
  VibiumStartOptions,
} from './types.ts';
