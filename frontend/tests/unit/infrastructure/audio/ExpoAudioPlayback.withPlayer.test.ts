import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ExpoAudioPlayback } from '../../../../src/infrastructure/audio/ExpoAudioPlayback';

/**
 * expo-audio 的动态 import() 在这个 Jest 环境下天然会抛错（没有
 * --experimental-vm-modules），jest.mock('expo-audio', ...) 拦不住它——见
 * ExpoAudioPlayback.ts 构造函数上新加的注入口子。这里直接注入一个假的
 * loadExpoAudioModule，绕开真的动态 import，测真正的播放逻辑。
 */
describe('ExpoAudioPlayback (fake native audio module injected)', () => {
  const player = {
    pause: jest.fn(),
    replace: jest.fn(),
    play: jest.fn(),
    volume: 0,
    loop: false,
  };
  const setAudioModeAsync = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const createAudioPlayer = jest.fn(() => player);
  const loadExpoAudioModule = jest.fn(async () => ({ createAudioPlayer, setAudioModeAsync }));

  beforeEach(() => {
    jest.clearAllMocks();
    setAudioModeAsync.mockResolvedValue(undefined);
    player.volume = 0;
    player.loop = false;
  });

  it('playTts configures audio mode once, plays the decoded bytes looped, and marks played: true', async () => {
    const audio = new ExpoAudioPlayback(loadExpoAudioModule);
    const receipt = await audio.playTts({
      schedule_id: 'sch-1',
      data: new Uint8Array([1, 2, 3]),
      format: 'wav',
    });

    expect(receipt).toEqual({ playback_id: 'tts-sch-1', played: true, used_local_fallback: false });
    expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
    expect(createAudioPlayer).toHaveBeenCalledTimes(1);
    expect(player.replace).toHaveBeenCalledWith(expect.stringContaining('data:audio/wav;base64,'));
    expect(player.loop).toBe(true);
    expect(player.volume).toBe(1);
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('playLocalFallback plays the bundled alarm sound when there is no data', async () => {
    const audio = new ExpoAudioPlayback(loadExpoAudioModule);
    const receipt = await audio.playLocalFallback({ schedule_id: 'sch-1' });

    expect(receipt).toEqual({
      playback_id: 'local-bundled-sch-1',
      played: true,
      used_local_fallback: true,
    });
    // 打包的兜底音效是一个 Metro 资源 id（number），不是 data URI 字符串。
    expect(player.replace).toHaveBeenCalledWith(expect.any(Number));
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('reuses the same underlying player across repeated plays instead of recreating it', async () => {
    const audio = new ExpoAudioPlayback(loadExpoAudioModule);
    await audio.playTts({ schedule_id: 'sch-1', data: new Uint8Array([1]), format: 'wav' });
    await audio.playTts({ schedule_id: 'sch-2', data: new Uint8Array([2]), format: 'wav' });

    expect(createAudioPlayer).toHaveBeenCalledTimes(1);
    expect(player.pause).toHaveBeenCalledTimes(2);
  });

  it('sets up the audio mode only once across multiple plays', async () => {
    const audio = new ExpoAudioPlayback(loadExpoAudioModule);
    await audio.playTts({ schedule_id: 'sch-1', data: new Uint8Array([1]), format: 'wav' });
    await audio.playTts({ schedule_id: 'sch-2', data: new Uint8Array([2]), format: 'wav' });

    expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
  });

  it('stop() pauses and un-loops the player only when the schedule is the active one', async () => {
    const audio = new ExpoAudioPlayback(loadExpoAudioModule);
    await audio.playTts({ schedule_id: 'sch-1', data: new Uint8Array([1]), format: 'wav' });

    await audio.stop('sch-2');
    expect(player.pause).toHaveBeenCalledTimes(1); // only the initial play-time pause() so far

    await audio.stop('sch-1');
    expect(player.pause).toHaveBeenCalledTimes(2);
    expect(player.loop).toBe(false);
  });

  it('retries setAudioModeAsync on the next play after a failed attempt instead of caching the failure', async () => {
    setAudioModeAsync.mockRejectedValueOnce(new Error('mode setup failed'));
    const audio = new ExpoAudioPlayback(loadExpoAudioModule);

    const first = await audio.playTts({
      schedule_id: 'sch-1',
      data: new Uint8Array([1]),
      format: 'wav',
    });
    expect(first.played).toBe(true); // ensureAudioMode awaits but doesn't propagate the rejection

    await audio.playTts({ schedule_id: 'sch-2', data: new Uint8Array([2]), format: 'wav' });
    expect(setAudioModeAsync).toHaveBeenCalledTimes(2);
  });

  it('treats a module without createAudioPlayer as unavailable', async () => {
    const audio = new ExpoAudioPlayback(async () => null);
    const receipt = await audio.playTts({
      schedule_id: 'sch-1',
      data: new Uint8Array([1]),
      format: 'wav',
    });
    expect(receipt.played).toBe(false);
  });
});
