import { describe, expect, it } from '@jest/globals';

import { ExpoAudioPlayback } from '../../../../src/infrastructure/audio/ExpoAudioPlayback';

describe('ExpoAudioPlayback', () => {
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
    const audio = new ExpoAudioPlayback();
    const data = new Uint8Array([1, 2, 3]);
    await expect(audio.playTts({ schedule_id: 's1', data, format: 'wav' })).resolves.toEqual({
      playback_id: 'tts-s1',
      played: false,
      used_local_fallback: false,
    });
    await expect(audio.stop('s1')).resolves.toBeUndefined();
  });

  it('marks local fallback even when playback cannot start', async () => {
    const audio = new ExpoAudioPlayback();
    const data = new Uint8Array([9]);
    await expect(
      audio.playLocalFallback({ schedule_id: 's2', data, format: 'mp3' }),
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
});
