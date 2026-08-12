import type {
  AudioPlaybackPort,
  AudioPlaybackReceipt,
  AudioPlaybackRequest,
} from '../../features/reminder/application/interfaces';
import { buildAudioDataUri } from './audioDataUri';

type AudioPlayerLike = {
  pause: () => void;
  replace: (source: string) => void;
  play: () => void;
  volume: number;
};

type ExpoAudioModule = {
  createAudioPlayer: (source?: string | null) => AudioPlayerLike;
  setAudioModeAsync: (mode: Record<string, unknown>) => Promise<void>;
};

/**
 * 音频播放适配器：在已安装 expo-audio 时播放 data URI；
 * 否则标记为本地兜底占位（不抛错，便于无原生依赖环境开发）。
 */
export class ExpoAudioPlayback implements AudioPlaybackPort {
  private player: AudioPlayerLike | null = null;
  private activeScheduleId: string | null = null;
  private modeReady: Promise<void> | null = null;

  async isTtsAvailable(): Promise<boolean> {
    // TTS 字节管线尚未接入；有 data 时由 playTts 直接播放。
    return false;
  }

  async playTts(request: AudioPlaybackRequest): Promise<AudioPlaybackReceipt> {
    if (request.data == null || request.data.byteLength === 0) {
      return {
        playback_id: `tts-empty-${request.schedule_id}`,
        played: false,
        used_local_fallback: false,
      };
    }
    const played = await this.playBytes(request.schedule_id, request.data, request.format ?? 'wav');
    return {
      playback_id: `tts-${request.schedule_id}`,
      played,
      used_local_fallback: false,
    };
  }

  async playLocalFallback(request: AudioPlaybackRequest): Promise<AudioPlaybackReceipt> {
    if (request.data != null && request.data.byteLength > 0) {
      const played = await this.playBytes(
        request.schedule_id,
        request.data,
        request.format ?? 'wav',
      );
      return {
        playback_id: `local-${request.schedule_id}`,
        played,
        used_local_fallback: true,
      };
    }
    return {
      playback_id: `local-placeholder-${request.schedule_id}`,
      played: false,
      used_local_fallback: true,
    };
  }

  async stop(scheduleId: string): Promise<void> {
    if (this.activeScheduleId !== scheduleId) return;
    this.player?.pause();
    this.activeScheduleId = null;
  }

  private async playBytes(scheduleId: string, data: Uint8Array, format: string): Promise<boolean> {
    const expoAudio = await loadExpoAudio();
    if (expoAudio == null) return false;

    await this.ensureAudioMode(expoAudio);
    if (this.player == null) {
      this.player = expoAudio.createAudioPlayer(null);
    }

    this.player.pause();
    this.player.replace(buildAudioDataUri(data, format));
    this.player.volume = 1;
    this.activeScheduleId = scheduleId;
    this.player.play();
    return true;
  }

  private async ensureAudioMode(expoAudio: ExpoAudioModule): Promise<void> {
    if (this.modeReady == null) {
      this.modeReady = expoAudio
        .setAudioModeAsync({
          allowsRecording: false,
          interruptionMode: 'doNotMix',
          playsInSilentMode: true,
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
        })
        .catch(() => undefined);
    }
    await this.modeReady;
  }
}

async function loadExpoAudio(): Promise<ExpoAudioModule | null> {
  try {
    // Optional peer dependency for environments that have not installed expo-audio yet.
    const mod = await import('expo-audio');
    if (typeof mod.createAudioPlayer !== 'function') return null;
    return mod as unknown as ExpoAudioModule;
  } catch {
    return null;
  }
}
