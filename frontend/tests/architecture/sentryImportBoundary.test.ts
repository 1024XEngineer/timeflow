import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

describe('sentry import boundary', () => {
  it('keeps @sentry/react-native inside infrastructure observability', () => {
    const sourceRoot = resolve(projectRoot, 'src');
    const imports = listSourceFiles(sourceRoot)
      .filter((file) => readFileSync(file, 'utf8').includes('@sentry/react-native'))
      .map((file) => normalizePath(relative(projectRoot, file)))
      .sort();

    expect(imports).toEqual([
      'src/infrastructure/observability/SentryClientTelemetry.ts',
      'src/infrastructure/observability/initSentry.ts',
    ]);
  });

  it('does not let features import the Sentry adapter', () => {
    const featuresRoot = resolve(projectRoot, 'src/features');
    const imports = listSourceFiles(featuresRoot)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return (
          source.includes('infrastructure/observability') || source.includes('@sentry/react-native')
        );
      })
      .map((file) => normalizePath(relative(projectRoot, file)));

    expect(imports).toEqual([]);
  });

  it('keeps the Sentry adapter in infrastructure', () => {
    expect(
      existsSync(resolve(projectRoot, 'src/infrastructure/observability/SentryClientTelemetry.ts')),
    ).toBe(true);
  });
});

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }
    if (['.ts', '.tsx'].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}
