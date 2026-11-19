/**
 * The parts of Vibium's API the adapter uses, as structural types, so this
 * package's declarations never name `vibium` and type-check in a project
 * without it. `tests/vibium-types.test.ts` holds them to the real ones.
 * Checked against vibium 26.11.16.
 */

export interface VibiumModelOptions {
  readonly provider?: 'openai' | 'xai' | 'anthropic' | 'google' | 'openai-compatible' | 'local';
  readonly model?: string;
  /** The model provider's API base URL, not the site under test. */
  readonly aiBaseURL?: string;
  readonly reasoningEffort?: string;
}

export interface VibiumObservation {
  readonly type: 'observation';
  readonly summary: string;
}

export interface VibiumRunResult {
  readonly status: 'completed' | 'not_completed';
  readonly goal: string;
  readonly summary: string;
  readonly reason?: 'action_limit' | 'missing_information' | 'safety_stop';
  readonly evidence: readonly VibiumObservation[];
}

export interface VibiumCheckResult {
  readonly status: 'passed' | 'failed' | 'inconclusive';
  readonly claim: string;
  readonly summary: string;
  readonly reason?: 'action_limit' | 'insufficient_evidence' | 'safety_stop' | 'archive_missing_evidence';
  readonly evidence: readonly VibiumObservation[];
}

export interface VibiumRequest {
  url(): string;
  method(): string;
}

export interface VibiumRoute {
  readonly request: VibiumRequest;
  abort(): Promise<void>;
  continue(): Promise<void>;
}

export interface VibiumRecordingStartOptions {
  name?: string;
  title?: string;
  screenshots?: boolean;
  snapshots?: boolean;
  path?: string | null;
}

export interface VibiumRecording {
  start(options?: VibiumRecordingStartOptions): Promise<void>;
  stop(options?: { path?: string }): Promise<{ path?: string }>;
  startGroup(name: string): Promise<void>;
  stopGroup(): Promise<void>;
}

export interface VibiumPage {
  run(goal: string, options?: VibiumModelOptions & { baseURL?: string }): Promise<VibiumRunResult>;
  check(claim: string, options?: VibiumModelOptions & { baseURL?: string; record?: string }): Promise<VibiumCheckResult>;
  go(url: string): Promise<void>;
  route(pattern: string, handler: (route: VibiumRoute) => void): Promise<void>;
  readonly context: { readonly recording: VibiumRecording };
}

export interface VibiumBrowser {
  page(): Promise<VibiumPage>;
  stop(): Promise<void>;
}

export interface VibiumStartOptions {
  engine?: 'chrome' | 'firefox';
  channel?: string;
  headless?: boolean;
  executablePath?: string;
  args?: string[];
  userDataDir?: string;
}

/** What `import('vibium')` must provide. */
export interface VibiumModule {
  readonly browser: {
    start(options?: VibiumStartOptions): Promise<VibiumBrowser>;
    /** Judges a saved recording without a browser. */
    check(claim: string, options: VibiumModelOptions & { record: string }): Promise<VibiumCheckResult>;
  };
}

/** What a Vibium hook and step kind get as fixtures. */
export interface VibiumFixtures {
  readonly browser: VibiumBrowser;
  readonly page: VibiumPage;
}
