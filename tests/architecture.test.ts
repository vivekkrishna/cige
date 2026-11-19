/**
 * The layering the package promises: the CIGE model (`src/core`) and the
 * runner kit (`src/runner`) import no runner and no adapter, so a project on
 * any one runner installs only that one. The adapters import their runner
 * only from their own directory.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { importsOf } from '../src/core/imports.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(path.join(SRC, directory), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(directory, file));
}

/** Every module a source names: static imports, re-exports, `import()`, type-only imports included. */
function specifiers(file: string): string[] {
  const text = readFileSync(path.join(SRC, file), 'utf8');
  const found = importsOf(text, file);
  // Type-only imports erase at build, but they reach a `.d.ts`, so they count too.
  const typeOnly = [...text.matchAll(/^\s*(?:import|export)\s+type\b[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1]!);
  return [...found.specifiers, ...found.requires, ...typeOnly];
}

const RUNNERS = /^(e2e|vibium)(\/|$)/;

describe('architecture', () => {
  for (const layer of ['core', 'runner']) {
    it(`keeps src/${layer} free of every runner and adapter`, () => {
      const offending = sources(layer).flatMap((file) =>
        specifiers(file)
          .filter((specifier) => RUNNERS.test(specifier) || specifier.includes('/adapters/') || specifier.includes('/cli/'))
          .map((specifier) => `${file} imports ${specifier}`),
      );
      expect(offending).toEqual([]);
    });
  }

  it('keeps each adapter to its own runner', () => {
    const offending = [
      ...sources('adapters/e2e').flatMap((file) => specifiers(file).filter((s) => /^vibium(\/|$)/.test(s) || s.includes('/vibium/')).map((s) => `${file} imports ${s}`)),
      ...sources('adapters/vibium').flatMap((file) => specifiers(file).filter((s) => /^e2e(\/|$)/.test(s) || s.includes('/e2e/')).map((s) => `${file} imports ${s}`)),
    ];
    expect(offending).toEqual([]);
  });

  it('loads the cige command without importing either runner at startup', () => {
    // The bin may load a runner lazily, once one is picked; never at the top of a module it loads first.
    const staticRunnerImports = sources('cli').flatMap((file) => {
      const text = readFileSync(path.join(SRC, file), 'utf8');
      return [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)]
        .map((match) => match[1]!)
        .filter((specifier) => RUNNERS.test(specifier) || specifier.includes('/adapters/'))
        .map((specifier) => `${file} imports ${specifier}`);
    });
    expect(staticRunnerImports).toEqual([]);
  });
});
