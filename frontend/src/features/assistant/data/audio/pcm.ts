/** 与原生采集一致：16kHz 单声道 pcm_s16le，约 100ms 一帧。 */
export const PCM_S16LE_SAMPLE_RATE_HZ = 16000;
export const PCM_CHUNK_INTERVAL_MS = 100;
export const PCM_S16LE_SAMPLES_PER_CHUNK =
  (PCM_S16LE_SAMPLE_RATE_HZ * PCM_CHUNK_INTERVAL_MS) / 1000;
const MIN_DBFS = -160;
const MAX_DBFS = 0;

export function resampleLinear(
  input: Float32Array,
  fromRateHz: number,
  toRateHz: number,
): Float32Array<ArrayBuffer> {
  if (input.length === 0 || fromRateHz <= 0 || toRateHz <= 0) {
    return new Float32Array(0);
  }
  if (fromRateHz === toRateHz) {
    const copy = new Float32Array(input.length);
    copy.set(input);
    return copy;
  }
  const ratio = fromRateHz / toRateHz;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  const lastIndex = input.length - 1;
  for (let i = 0; i < outLength; i += 1) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, lastIndex);
    const fraction = sourceIndex - left;
    const leftSample = input[left] ?? 0;
    const rightSample = input[right] ?? 0;
    output[i] = leftSample + (rightSample - leftSample) * fraction;
  }
  return output;
}

export function float32ToPcmS16le(input: Float32Array): ArrayBuffer {
  const bytes = new ArrayBuffer(input.length * 2);
  const pcm = new Int16Array(bytes);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    pcm[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return bytes;
}

export function pcmS16leToFloat32(buffer: ArrayBuffer): Float32Array<ArrayBuffer> {
  const pcm = new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
  const output = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] ?? 0;
    output[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
  }
  return output;
}

export function float32SoundLevelDbFs(input: Float32Array): number {
  if (input.length === 0) {
    return MIN_DBFS;
  }
  let sumSquares = 0;
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] ?? 0;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / input.length);
  if (rms <= 0) {
    return MIN_DBFS;
  }
  return Math.max(MIN_DBFS, Math.min(MAX_DBFS, 20 * Math.log10(rms)));
}

export function concatFloat32(
  left: Float32Array,
  right: Float32Array,
): Float32Array<ArrayBuffer> {
  const output = new Float32Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

export function drainPcmChunks(
  pending: Float32Array,
  samplesPerChunk: number = PCM_S16LE_SAMPLES_PER_CHUNK,
): {
  readonly remaining: Float32Array<ArrayBuffer>;
  readonly chunks: readonly { pcm: ArrayBuffer; soundLevel: number }[];
} {
  const chunks: { pcm: ArrayBuffer; soundLevel: number }[] = [];
  let offset = 0;
  while (pending.length - offset >= samplesPerChunk) {
    const frame = pending.subarray(offset, offset + samplesPerChunk);
    chunks.push({
      pcm: float32ToPcmS16le(frame),
      soundLevel: float32SoundLevelDbFs(frame),
    });
    offset += samplesPerChunk;
  }
  const remaining = new Float32Array(pending.length - offset);
  remaining.set(pending.subarray(offset));
  return {
    chunks,
    remaining,
  };
}
