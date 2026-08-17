import { describe, expect, it } from '@jest/globals';

import {
  drainPcmChunks,
  float32SoundLevelDbFs,
  float32ToPcmS16le,
  pcmS16leToFloat32,
  PCM_S16LE_SAMPLES_PER_CHUNK,
  resampleLinear,
} from '../../../../../src/features/assistant/data/audio/pcm';

describe('pcm helpers', () => {
  it('round-trips float32 through pcm_s16le within quantization error', () => {
    const original = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const restored = pcmS16leToFloat32(float32ToPcmS16le(original));

    expect(restored.length).toBe(original.length);
    restored.forEach((sample, index) => {
      expect(sample).toBeCloseTo(original[index] ?? 0, 3);
    });
  });

  it('reports silence as -160 dBFS and full-scale as near 0', () => {
    expect(float32SoundLevelDbFs(new Float32Array(1600))).toBe(-160);
    expect(float32SoundLevelDbFs(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(0, 5);
  });

  it('resamples 48 kHz audio down to 16 kHz', () => {
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i += 1) {
      input[i] = i % 2 === 0 ? 0.25 : -0.25;
    }

    const output = resampleLinear(input, 48000, 16000);

    expect(output.length).toBe(1600);
    expect(output[0]).toBeCloseTo(0.25, 5);
  });

  it('copies same-rate input so the ScriptProcessor buffer can be reused', () => {
    const input = new Float32Array([0.1, 0.2]);
    const output = resampleLinear(input, 16000, 16000);
    input[0] = 9;
    expect(output[0]).toBeCloseTo(0.1, 5);
  });

  it('emits 100ms pcm_s16le frames and keeps the remainder', () => {
    const pending = new Float32Array(PCM_S16LE_SAMPLES_PER_CHUNK + 40);
    pending.fill(0.1);
    const { chunks, remaining } = drainPcmChunks(pending);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.pcm.byteLength).toBe(PCM_S16LE_SAMPLES_PER_CHUNK * 2);
    expect(chunks[0]?.soundLevel).toBeGreaterThan(-160);
    expect(remaining.length).toBe(40);
  });
});
