import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const nativeImport = /from ['"]@irvingouj\/expo-audio-stream['"]/;
const nativeAdapters = new Set(['ExpoAudioCapture.ts', 'ExpoAudioPlayback.ts']);

describe('assistant audio web adapters', () => {
  it('keeps native expo-audio-stream imports on the Android adapters only', () => {
    const audioDir = resolve(projectRoot, 'src/features/assistant/data/audio');
    const importedBy = readdirSync(audioDir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => nativeImport.test(readFileSync(resolve(audioDir, file), 'utf8')))
      .sort();

    expect(importedBy).toEqual([...nativeAdapters].sort());
  });
});
