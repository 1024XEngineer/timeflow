import { describe, expect, it } from '@jest/globals';

import { buildAudioDataUri, encodeBase64 } from '../../../../src/infrastructure/audio/audioDataUri';

describe('encodeBase64', () => {
  it('encodes an empty array to an empty string', () => {
    expect(encodeBase64(new Uint8Array())).toBe('');
  });

  it('encodes a length divisible by 3 without padding', () => {
    // "Man" -> "TWFu" is the classic RFC 4648 base64 test vector.
    const bytes = new Uint8Array([0x4d, 0x61, 0x6e]);
    expect(encodeBase64(bytes)).toBe('TWFu');
  });

  it('pads with one "=" when one byte is left over', () => {
    // "Ma" -> "TWE="
    const bytes = new Uint8Array([0x4d, 0x61]);
    expect(encodeBase64(bytes)).toBe('TWE=');
  });

  it('pads with two "=" when two bytes are left over', () => {
    // "M" -> "TQ=="
    const bytes = new Uint8Array([0x4d]);
    expect(encodeBase64(bytes)).toBe('TQ==');
  });
});

describe('buildAudioDataUri', () => {
  it('maps a known extension to its registered MIME type', () => {
    const uri = buildAudioDataUri(new Uint8Array([1, 2, 3]), 'mp3');
    expect(uri.startsWith('data:audio/mpeg;base64,')).toBe(true);
  });

  it('normalizes a leading dot, whitespace, and case before lookup', () => {
    const uri = buildAudioDataUri(new Uint8Array([1, 2, 3]), '  .WAV  ');
    expect(uri.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('falls back to audio/<format> for an unregistered but valid format', () => {
    const uri = buildAudioDataUri(new Uint8Array([1, 2, 3]), 'opus');
    expect(uri.startsWith('data:audio/opus;base64,')).toBe(true);
  });

  it('embeds the base64-encoded bytes after the comma', () => {
    const uri = buildAudioDataUri(new Uint8Array([0x4d, 0x61, 0x6e]), 'wav');
    expect(uri).toBe('data:audio/wav;base64,TWFu');
  });

  it('rejects a format that fails the allowed-character pattern', () => {
    expect(() => buildAudioDataUri(new Uint8Array([1]), '')).toThrow(
      'Unsupported reminder audio format',
    );
    expect(() => buildAudioDataUri(new Uint8Array([1]), '../etc')).toThrow(
      'Unsupported reminder audio format',
    );
  });
});
