import { describe, expect, it } from '@jest/globals';

import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from '../../../../../../src/features/assistant/data/audio/base64';

describe('arrayBufferToBase64 / base64ToArrayBuffer', () => {
  it('encodes an empty buffer to an empty string', () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
  });

  it('encodes the classic RFC 4648 "Man" vector', () => {
    const bytes = new Uint8Array([0x4d, 0x61, 0x6e]);
    expect(arrayBufferToBase64(bytes.buffer)).toBe('TWFu');
  });

  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = i;
    }
    const decoded = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(bytes.buffer)));
    expect(decoded).toEqual(bytes);
  });

  it('round-trips a payload spanning multiple chunks', () => {
    // 70 KB 跨三块（0x8000 = 32768），确保分块拼接路径被覆盖。
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (i * 7 + 3) & 0xff;
    }
    const encoded = arrayBufferToBase64(bytes.buffer);
    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    const decoded = new Uint8Array(base64ToArrayBuffer(encoded));
    expect(decoded).toEqual(bytes);
  });
});
