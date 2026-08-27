import { describe, expect, it } from '@jest/globals';

import { splitPcm } from '../../../../../../src/features/assistant/data/audio/split-pcm';

describe('splitPcm', () => {
  it('returns an empty array for an empty buffer', () => {
    expect(splitPcm(new ArrayBuffer(0), 100)).toEqual([]);
  });

  it('returns the whole buffer as one piece when smaller than chunkBytes', () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const pieces = splitPcm(buffer, 100);
    expect(pieces).toHaveLength(1);
    expect(new Uint8Array(pieces[0])).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('splits an exact multiple into equal pieces', () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
    const pieces = splitPcm(buffer, 2);
    expect(pieces.map((piece) => Array.from(new Uint8Array(piece)))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it('splits a non-multiple with a short tail piece', () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const pieces = splitPcm(buffer, 2);
    expect(pieces.map((piece) => Array.from(new Uint8Array(piece)))).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('rejects a non-positive chunk size', () => {
    expect(() => splitPcm(new ArrayBuffer(10), 0)).toThrow();
    expect(() => splitPcm(new ArrayBuffer(10), -1)).toThrow();
    expect(() => splitPcm(new ArrayBuffer(10), Number.NaN)).toThrow();
  });
});
