import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ExpoAudioCapture } from '../../../../../src/features/assistant/data/audio/ExpoAudioCapture.web';
import { ExpoAudioPlayback } from '../../../../../src/features/assistant/data/audio/ExpoAudioPlayback.web';
import { float32ToPcmS16le } from '../../../../../src/features/assistant/data/audio/pcm';
import type { WebAudioRuntime } from '../../../../../src/features/assistant/data/audio/webAudioRuntime';

type FakeTrack = { stop: ReturnType<typeof jest.fn> };

function createFakeStream(): { stream: MediaStream; track: FakeTrack } {
  const track: FakeTrack = { stop: jest.fn() };
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

function createFakeAudioContext(sampleRate = 16000) {
  const source = { connect: jest.fn(), disconnect: jest.fn() };
  const gain = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    gain: { value: 1 },
  };
  const processor = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
  };
  const sources: { start: ReturnType<typeof jest.fn>; stop: ReturnType<typeof jest.fn> }[] = [];
  const context = {
    close: jest.fn(async () => {
      context.state = 'closed';
    }),
    createBuffer: (channels: number, length: number, rate: number) => ({
      copyToChannel: jest.fn(),
      duration: length / rate,
      length,
      numberOfChannels: channels,
      sampleRate: rate,
    }),
    createBufferSource: () => {
      const node = {
        buffer: null as AudioBuffer | null,
        connect: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      };
      sources.push(node);
      return node;
    },
    createGain: () => gain,
    createMediaStreamSource: () => source,
    createScriptProcessor: () => processor,
    currentTime: 0,
    destination: {},
    resume: jest.fn(async () => undefined),
    sampleRate,
    state: 'running',
  };
  return { context, gain, processor, source, sources };
}

describe('Expo audio web adapters', () => {
  let getUserMedia: jest.MockedFunction<WebAudioRuntime['getUserMedia']>;
  let fakeStream: ReturnType<typeof createFakeStream>;
  let fakeContext: ReturnType<typeof createFakeAudioContext>;
  let runtime: WebAudioRuntime;

  beforeEach(() => {
    fakeStream = createFakeStream();
    fakeContext = createFakeAudioContext();
    getUserMedia = jest.fn(async () => fakeStream.stream);
    runtime = {
      createAudioContext: () => fakeContext.context as unknown as AudioContext,
      getUserMedia,
    };
  });

  it('requests the browser microphone and stops the probe tracks', async () => {
    const capture = new ExpoAudioCapture(runtime);

    await expect(capture.requestPermission()).resolves.toBe(true);
    expect(getUserMedia).toHaveBeenCalled();
    expect(fakeStream.track.stop).toHaveBeenCalledTimes(1);
  });

  it('returns false when the browser denies the microphone', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('denied'));
    const capture = new ExpoAudioCapture(runtime);

    await expect(capture.requestPermission()).resolves.toBe(false);
  });

  it('emits 16 kHz pcm_s16le chunks from ScriptProcessor frames', async () => {
    const capture = new ExpoAudioCapture(runtime);
    const chunks: ArrayBuffer[] = [];
    const levels: (number | null)[] = [];

    await capture.start((chunk, soundLevel) => {
      chunks.push(chunk);
      levels.push(soundLevel);
    });

    const frame = new Float32Array(4096);
    frame.fill(0.2);
    fakeContext.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => frame },
    } as unknown as AudioProcessingEvent);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.byteLength).toBe(3200);
    expect(levels[0]).toBeGreaterThan(-160);

    await capture.stop();
    expect(fakeStream.track.stop).toHaveBeenCalled();
    expect(fakeContext.context.close).toHaveBeenCalled();
  });

  it('queues TTS pcm chunks and interrupts them on stop', async () => {
    const playback = new ExpoAudioPlayback(runtime);
    const pcm = float32ToPcmS16le(new Float32Array(240));

    await expect(playback.pushChunk(pcm)).rejects.toThrow('pushChunk called before startStream');

    await playback.startStream({ encoding: 'pcm_s16le', sampleRateHz: 16000 });
    await playback.pushChunk(pcm);
    expect(fakeContext.sources).toHaveLength(1);
    expect(fakeContext.sources[0]?.start).toHaveBeenCalled();

    await playback.endStream();
    await expect(playback.pushChunk(pcm)).rejects.toThrow('pushChunk called before startStream');

    await playback.stop();
    expect(fakeContext.sources[0]?.stop).toHaveBeenCalled();
    expect(fakeContext.context.close).toHaveBeenCalled();
  });
});
