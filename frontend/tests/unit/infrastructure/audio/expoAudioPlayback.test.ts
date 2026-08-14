import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ExpoAudioPlayback } from '../../../../src/infrastructure/audio/ExpoAudioPlayback';

type AudioStatusLike = {
  playing?: boolean;
  error?: string | null;
};

type AudioPlayerMock = {
  playing: boolean;
  volume: number;
  pause: jest.MockedFunction<() => void>;
  replace: jest.MockedFunction<(source: string) => void>;
  play: jest.MockedFunction<() => void>;
  addListener: jest.MockedFunction<
    (
      eventName: 'playbackStatusUpdate',
      listener: (status: AudioStatusLike) => void,
    ) => { remove: () => void }
  >;
};

type ExpoAudioMock = {
  createAudioPlayer: jest.MockedFunction<(source?: string | null) => AudioPlayerMock>;
  setAudioModeAsync: jest.MockedFunction<(mode: Record<string, unknown>) => Promise<void>>;
};

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(),
  setAudioModeAsync: jest.fn(async () => undefined),
}));

function expoAudio(): ExpoAudioMock {
  return jest.requireMock('expo-audio') as ExpoAudioMock;
}

function createPlayer(overrides: Partial<AudioPlayerMock> = {}): AudioPlayerMock {
  const listeners = new Set<(status: AudioStatusLike) => void>();
  const player = {
    playing: false,
    volume: 1,
    pause: jest.fn(() => undefined),
    replace: jest.fn(() => undefined),
    play: jest.fn(() => undefined),
    addListener: jest.fn((_eventName, listener) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    }),
    ...overrides,
  } as AudioPlayerMock;
  if (overrides.play == null) {
    player.play.mockImplementation(() => {
      player.playing = true;
      for (const listener of listeners) listener({ playing: true });
    });
  }
  return player;
}

const DATA = new Uint8Array([1, 2, 3]);

describe('ExpoAudioPlayback', () => {
  beforeEach(() => {
    const audio = expoAudio();
    audio.createAudioPlayer.mockReset();
    audio.setAudioModeAsync.mockReset();
    audio.setAudioModeAsync.mockResolvedValue(undefined);
    audio.createAudioPlayer.mockImplementation(() => createPlayer());
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reports TTS as unavailable', async () => {
    const audio = new ExpoAudioPlayback();
    await expect(audio.isTtsAvailable()).resolves.toBe(false);
  });

  it('does not play empty TTS bytes', async () => {
    const audio = new ExpoAudioPlayback();
    await expect(audio.playTts({ schedule_id: 's1' })).resolves.toEqual({
      playback_id: 'tts-empty-s1',
      played: false,
      used_local_fallback: false,
    });
  });

  it('degrades to unplayed when expo-audio cannot be loaded', async () => {
    const module = expoAudio();
    const original = module.createAudioPlayer;
    module.createAudioPlayer = undefined as never;
    const audio = new ExpoAudioPlayback();
    await expect(audio.playTts({ schedule_id: 's1', data: DATA, format: 'wav' })).resolves.toEqual({
      playback_id: 'tts-s1',
      played: false,
      used_local_fallback: false,
    });
    await expect(audio.stop('s1')).resolves.toBeUndefined();
    module.createAudioPlayer = original;
  });

  it('marks local fallback even when playback cannot start', async () => {
    expoAudio().createAudioPlayer.mockImplementation(() => {
      throw new Error('native player missing');
    });
    const audio = new ExpoAudioPlayback();
    await expect(
      audio.playLocalFallback({ schedule_id: 's2', data: new Uint8Array([9]), format: 'mp3' }),
    ).resolves.toEqual({
      playback_id: 'local-s2',
      played: false,
      used_local_fallback: true,
    });
  });

  it('returns a local placeholder when fallback has no bytes', async () => {
    const audio = new ExpoAudioPlayback();
    await expect(audio.playLocalFallback({ schedule_id: 's3' })).resolves.toEqual({
      playback_id: 'local-placeholder-s3',
      played: false,
      used_local_fallback: true,
    });
  });

  it('reports unplayed when setAudioModeAsync rejects', async () => {
    expoAudio().setAudioModeAsync.mockRejectedValue(new Error('mode denied'));
    const audio = new ExpoAudioPlayback();
    await expect(audio.playTts({ schedule_id: 's1', data: DATA, format: 'wav' })).resolves.toEqual({
      playback_id: 'tts-s1',
      played: false,
      used_local_fallback: false,
    });
    expect(expoAudio().createAudioPlayer).not.toHaveBeenCalled();
  });

  it('reports unplayed when replace throws', async () => {
    const player = createPlayer({
      replace: jest.fn(() => {
        throw new Error('replace failed');
      }),
    });
    expoAudio().createAudioPlayer.mockReturnValue(player);
    const audio = new ExpoAudioPlayback();
    await expect(audio.playTts({ schedule_id: 's1', data: DATA, format: 'wav' })).resolves.toEqual({
      playback_id: 'tts-s1',
      played: false,
      used_local_fallback: false,
    });
    expect(player.play).not.toHaveBeenCalled();
  });

  it('reports unplayed when play throws', async () => {
    const player = createPlayer({
      play: jest.fn(() => {
        throw new Error('play failed');
      }),
    });
    expoAudio().createAudioPlayer.mockReturnValue(player);
    const audio = new ExpoAudioPlayback();
    await expect(audio.playTts({ schedule_id: 's1', data: DATA, format: 'wav' })).resolves.toEqual({
      playback_id: 'tts-s1',
      played: false,
      used_local_fallback: false,
    });
  });

  it('reports unplayed when playback never enters playing', async () => {
    jest.useFakeTimers();
    const player = createPlayer({
      play: jest.fn(() => undefined),
    });
    expoAudio().createAudioPlayer.mockReturnValue(player);
    const audio = new ExpoAudioPlayback();
    const result = audio.playTts({ schedule_id: 's1', data: DATA, format: 'wav' });
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({
      playback_id: 'tts-s1',
      played: false,
      used_local_fallback: false,
    });
  });

  it('reports played after a playing status update', async () => {
    const audio = new ExpoAudioPlayback();
    await expect(audio.playTts({ schedule_id: 's1', data: DATA, format: 'wav' })).resolves.toEqual({
      playback_id: 'tts-s1',
      played: true,
      used_local_fallback: false,
    });
  });
});
