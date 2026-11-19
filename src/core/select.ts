/**
 * Which runner a case runs on. The case never says: Context names an
 * environment, never a tool. In order: `--runner`, the environment's
 * `runner`, the config's `runner`, the config's only runner when it lists
 * one, then e2e when it is installed (the runner every earlier config was
 * written for), then Vibium when it is.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { CigeConfig } from './config.ts';

const require = createRequire(import.meta.url);

/** Whether a package resolves from here. */
export function isInstalled(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/** The runners this package ships adapters for. */
export const BUILTIN_RUNNERS = ['e2e', 'vibium'] as const;

/** The runner a case runs on when no `--runner` is given. */
export function defaultRunnerName(config: Pick<CigeConfig<never>, 'runner' | 'runners'>, environmentRunner?: string): string {
  if (environmentRunner !== undefined) return environmentRunner;
  if (config.runner !== undefined) return config.runner;
  const listed = Object.keys(config.runners ?? {});
  if (listed.length === 1) return listed[0]!;
  if (isInstalled('e2e')) return 'e2e';
  if (isInstalled('vibium')) return 'vibium';
  return 'e2e';
}

/** The runner names a `--runner` value lists: `e2e`, `vibium`, or `e2e,vibium` for a matrix run. */
export function parseRunnerList(value: string): string[] {
  const names = value.split(',').map((name) => name.trim()).filter((name) => name !== '');
  return [...new Set(names)];
}

/** The installed version of a package, read from its package.json; `unknown` when it isn't installed. */
export function installedVersion(name: string): string {
  let entry: string;
  try {
    entry = require.resolve(name);
  } catch {
    return 'unknown';
  }
  for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
        if (typeof pkg === 'object' && pkg !== null && 'name' in pkg && pkg.name === name && 'version' in pkg && typeof pkg.version === 'string') return pkg.version;
      } catch {
        // Not this one.
      }
    }
    if (path.dirname(dir) === dir) return 'unknown';
  }
}
