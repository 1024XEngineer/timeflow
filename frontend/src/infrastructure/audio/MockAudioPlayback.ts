import type {
  AudioPlaybackPort,
  AudioPlaybackReceipt,
  AudioPlaybackRequest,
} from '../../features/reminder/application/interfaces';

/** 固定音频能力：远程语音合成不可用，本地兜底音效可用。 */
export class MockAudioPlayback implements AudioPlaybackPort {
  async isTtsAvailable(): Promise<boolean> {
    return false;
  }

  async playTts(_request: AudioPlaybackRequest): Promise<AudioPlaybackReceipt> {
    return {
      playback_id: 'mock-tts-playback-001',
      played: false,
      used_local_fallback: false,
    };
  }

  async playLocalFallback(_request: AudioPlaybackRequest): Promise<AudioPlaybackReceipt> {
    return {
      playback_id: 'mock-local-sound-001',
      played: true,
      used_local_fallback: true,
    };
  }

  async stop(_scheduleId: string): Promise<void> {
    return Promise.resolve();
  }
}
