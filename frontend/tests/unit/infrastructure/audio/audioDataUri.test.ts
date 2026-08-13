import { describe, expect, it } from '@jest/globals';

import { buildAudioDataUri, encodeBase64 } from '../../../../src/infrastructure/audio/audioDataUri';

describe('encodeBase64', () => {
  it('encodes empty, partial and full triplets', () => {
    expect(encodeBase64(new Uint8Array())).toBe('');
    expect(encodeBase64(new Uint8Array([77]))).toBe('TQ==');
    expect(encodeBase64(new Uint8Array([77, 97]))).toBe('TWE=');
    expect(encodeBase64(new Uint8Array([77, 97, 110]))).toBe('TWFu');
  });
});

describe('buildAudioDataUri', () => {
  it('maps known formats and strips a leading dot', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(buildAudioDataUri(bytes, 'wav')).toBe(`data:audio/wav;base64,${encodeBase64(bytes)}`);
    expect(buildAudioDataUri(bytes, '.mp3')).toBe(`data:audio/mpeg;base64,${encodeBase64(bytes)}`);
    expect(buildAudioDataUri(bytes, 'AAC')).toBe(`data:audio/aac;base64,${encodeBase64(bytes)}`);
  });

  it('falls back to audio/{format} for an unknown but valid token', () => {
    const bytes = new Uint8Array([9]);
    expect(buildAudioDataUri(bytes, 'flac')).toBe(`data:audio/flac;base64,${encodeBase64(bytes)}`);
  });

  it('rejects an unsupported format token', () => {
    expect(() => buildAudioDataUri(new Uint8Array([1]), 'not valid')).toThrow(
      'Unsupported reminder audio format',
    );
    expect(() => buildAudioDataUri(new Uint8Array([1]), '')).toThrow(
      'Unsupported reminder audio format',
    );
  });
});
