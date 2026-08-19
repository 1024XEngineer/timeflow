import { describe, expect, it } from '@jest/globals';

import { ExpoAudioPlayback } from '../../../../src/infrastructure/audio/ExpoAudioPlayback';

/**
 * expo-audio 是原生模块，Jest 环境里没有真实原生绑定，`import('expo-audio')`
 * 会自然失败——不额外 mock，正好覆盖 loadExpoAudio() 的失败分支（played: false）。
 * 成功播放路径（真的调用 createAudioPlayer）见同目录下
 * ExpoAudioPlayback.withPlayer.test.ts。
 */
describe('ExpoAudioPlayback (no native audio module available)', () => {
  it('reports TTS as unavailable', async () => {
    const audio = new ExpoAudioPlayback();
    await expect(audio.isTtsAvailable()).resolves.toBe(false);
  });

  it('playTts resolves played: false without touching native audio when data is empty', async () => {
    const audio = new ExpoAudioPlayback();
    await expect(
      audio.playTts({ schedule_id: 'sch-1', data: new Uint8Array() }),
    ).resolves.toEqual({
      playback_id: 'tts-empty-sch-1',
      played: false,
      used_local_fallback: false,
    });
  });

  it('playTts resolves played: false without data at all', async () => {
    const audio = new ExpoAudioPlayback();
    await expect(audio.playTts({ schedule_id: 'sch-1' })).resolves.toEqual({
      playback_id: 'tts-empty-sch-1',
      played: false,
      used_local_fallback: false,
    });
  });

  it('playTts resolves played: false when native audio cannot load, even with data', async () => {
    const audio = new ExpoAudioPlayback();
    const receipt = await audio.playTts({
      schedule_id: 'sch-1',
      data: new Uint8Array([1, 2, 3]),
      format: 'wav',
    });
    expect(receipt).toEqual({ playback_id: 'tts-sch-1', played: false, used_local_fallback: false });
  });

  it('playLocalFallback resolves played: false with data when native audio cannot load', async () => {
    const audio = new ExpoAudioPlayback();
    const receipt = await audio.playLocalFallback({
      schedule_id: 'sch-1',
      data: new Uint8Array([1, 2, 3]),
    });
    expect(receipt).toEqual({
      playback_id: 'local-sch-1',
      played: false,
      used_local_fallback: true,
    });
  });

  it('playLocalFallback falls back to the bundled alarm when there is no data, still played: false', async () => {
    const audio = new ExpoAudioPlayback();
    const receipt = await audio.playLocalFallback({ schedule_id: 'sch-1' });
    expect(receipt).toEqual({
      playback_id: 'local-bundled-sch-1',
      played: false,
      used_local_fallback: true,
    });
  });

  it('stop() resolves without an active schedule', async () => {
    const audio = new ExpoAudioPlayback();
    await expect(audio.stop('sch-1')).resolves.toBeUndefined();
  });
});
