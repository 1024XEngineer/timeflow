import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPlayAudio = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockSetSoundConfig = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockStopAudio = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.mock('@irvingouj/expo-audio-stream', () => ({
  EncodingTypes: { PCM_S16LE: 'pcm_s16le' },
  ExpoPlayAudioStream: {
    playAudio: (...args: unknown[]) => mockPlayAudio(...args),
    setSoundConfig: (...args: unknown[]) => mockSetSoundConfig(...args),
    stopAudio: (...args: unknown[]) => mockStopAudio(...args),
  },
}));

// eslint-disable-next-line import/first
import { ExpoAudioPlayback } from '../../../../../../src/features/assistant/data/audio/ExpoAudioPlayback';

/** 24000Hz、16bit 单声道下 100ms 一片 = 4800 字节，跟 SPLIT_MS 对齐。 */
const PIECE_BYTES = 4800;

const FORMAT = { encoding: 'pcm_s16le', sampleRateHz: 24000 } as const;

describe('ExpoAudioPlayback (assistant TTS stream)', () => {
  beforeEach(() => {
    mockPlayAudio.mockReset();
    mockSetSoundConfig.mockReset();
    mockStopAudio.mockReset();
    mockPlayAudio.mockResolvedValue(undefined);
    mockSetSoundConfig.mockResolvedValue(undefined);
    mockStopAudio.mockResolvedValue(undefined);
  });

  it('splits one chunk into pieces and writes them under the same stream id', async () => {
    const playback = new ExpoAudioPlayback();
    await playback.startStream(FORMAT);

    await playback.pushChunk(new ArrayBuffer(PIECE_BYTES * 3));

    expect(mockPlayAudio).toHaveBeenCalledTimes(3);
    const streamIds = new Set(mockPlayAudio.mock.calls.map(([, streamId]) => streamId));
    expect(streamIds.size).toBe(1);
    expect([...streamIds][0]).toEqual(expect.stringContaining('assistant-tts-'));
  });

  it('stops writing the rest of a chunk once the stream it belongs to is gone', async () => {
    // 打断的真实时序：stop() 在上一片还卡在原生桥上时到达。不重新确认这条流还
    // 是不是当前那条的话，剩下的片会在 stopAudio() 之后继续写进播放器，把刚被
    // 打断那句的尾巴放出来——而且那时 streamId 已经是 null，等于用一条野生的流播。
    const playback = new ExpoAudioPlayback();
    await playback.startStream(FORMAT);

    let releaseFirstPiece: () => void = () => {};
    mockPlayAudio.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstPiece = resolve;
        }),
    );

    const pushing = playback.pushChunk(new ArrayBuffer(PIECE_BYTES * 3));
    await playback.stop();
    releaseFirstPiece();
    await pushing;

    expect(mockStopAudio).toHaveBeenCalledTimes(1);
    expect(mockPlayAudio).toHaveBeenCalledTimes(1);
    expect(mockPlayAudio.mock.calls.every(([, streamId]) => streamId !== null)).toBe(true);
  });

  it('stops writing the rest of a chunk once a newer stream has taken over', async () => {
    // 同一件事的另一半：没有 stop()，直接来了下一条回复的 voice.tts.start。
    const playback = new ExpoAudioPlayback();
    await playback.startStream(FORMAT);

    let releaseFirstPiece: () => void = () => {};
    mockPlayAudio.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstPiece = resolve;
        }),
    );

    const pushing = playback.pushChunk(new ArrayBuffer(PIECE_BYTES * 3));
    await playback.startStream(FORMAT);
    releaseFirstPiece();
    await pushing;

    expect(mockPlayAudio).toHaveBeenCalledTimes(1);
  });

  it('holds the opening audio back until the player has a head start', async () => {
    // 原生模块的播放循环是「写一块、空等这块时长的 50%、再取下一块」，稳态下刚好
    // 打平，而 AudioTrack 的缓冲只有几十毫秒。队列一见底就是一个听得见的空隙，而
    // 每条回复刚开始的那几百毫秒队列恰恰最薄。先攒够一段再一次性交过去，让播放
    // 循环一开始就有存货。
    const playback = new ExpoAudioPlayback();
    await playback.startStream(FORMAT);

    await playback.pushChunk(new ArrayBuffer(PIECE_BYTES));
    expect(mockPlayAudio).not.toHaveBeenCalled();

    await playback.pushChunk(new ArrayBuffer(PIECE_BYTES));
    // 攒够 200ms，两块一起交出去。
    expect(mockPlayAudio).toHaveBeenCalledTimes(2);
  });

  it('stops holding audio back once the player has its head start', async () => {
    const playback = new ExpoAudioPlayback();
    await playback.startStream(FORMAT);
    await playback.pushChunk(new ArrayBuffer(PIECE_BYTES * 2));
    mockPlayAudio.mockClear();

    await playback.pushChunk(new ArrayBuffer(PIECE_BYTES));

    expect(mockPlayAudio).toHaveBeenCalledTimes(1);
  });

  it('still plays a reply too short to reach the head start', async () => {
    // 「好的。」这种一句话可能整条都不够门槛。收尾时必须把攒着的交出去，否则这句
    // 回复一个字都不会响。
    const playback = new ExpoAudioPlayback();
    await playback.startStream(FORMAT);
    await playback.pushChunk(new ArrayBuffer(PIECE_BYTES));
    expect(mockPlayAudio).not.toHaveBeenCalled();

    await playback.endStream();

    expect(mockPlayAudio).toHaveBeenCalledTimes(1);
  });

  it('throws away audio still being held when playback is stopped', async () => {
    // 打断时攒着的那段属于被放弃的那条回复，不能等下一条流开起来再补播出去。
    const playback = new ExpoAudioPlayback();
    await playback.startStream(FORMAT);
    await playback.pushChunk(new ArrayBuffer(PIECE_BYTES));

    await playback.stop();
    await playback.startStream(FORMAT);
    await playback.pushChunk(new ArrayBuffer(PIECE_BYTES));

    // 新流自己还没攒够，旧流那块也不该冒出来。
    expect(mockPlayAudio).not.toHaveBeenCalled();
  });

  it('refuses a chunk pushed before any stream was opened', async () => {
    const playback = new ExpoAudioPlayback();

    await expect(playback.pushChunk(new ArrayBuffer(PIECE_BYTES))).rejects.toThrow(
      'pushChunk called before startStream',
    );
  });

  it('endStream() closes the stream without touching the native player', async () => {
    const playback = new ExpoAudioPlayback();
    await playback.startStream(FORMAT);

    await playback.endStream();

    expect(mockStopAudio).not.toHaveBeenCalled();
    await expect(playback.pushChunk(new ArrayBuffer(PIECE_BYTES))).rejects.toThrow(
      'pushChunk called before startStream',
    );
  });
});
