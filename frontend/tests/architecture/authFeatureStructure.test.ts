import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

describe('auth feature structure', () => {
  it('does not retain the legacy top-level authentication API adapter', () => {
    expect(existsSync(resolve(projectRoot, 'src/api/auth.ts'))).toBe(false);
  });

  it('keeps the authentication API adapter within the auth feature data layer', () => {
    expect(existsSync(resolve(projectRoot, 'src/features/auth/data/auth.ts'))).toBe(true);
  });

  it('limits expo-secure-store imports to concrete auth data adapters and factories', () => {
    const sourceRoot = resolve(projectRoot, 'src');
    const imports = listSourceFiles(sourceRoot)
      .filter((file) => readFileSync(file, 'utf8').includes('expo-secure-store'))
      .map((file) => normalizePath(relative(projectRoot, file)));

    expect(imports).toEqual(['src/features/auth/data/createAuthSessionStore.ts']);
  });

  it('keeps account test doubles in the test tree', () => {
    expect(existsSync(resolve(projectRoot, 'src/features/auth/testing'))).toBe(false);
    expect(existsSync(resolve(projectRoot, 'src/infrastructure/websocket/testing'))).toBe(false);
    expect(existsSync(resolve(projectRoot, 'tests/fakes/FakeAuthSessionStore.ts'))).toBe(true);
    expect(existsSync(resolve(projectRoot, 'tests/fakes/FakeWebSocket.ts'))).toBe(true);
  });
});

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}
