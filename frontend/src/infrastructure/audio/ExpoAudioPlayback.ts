import type {
  AudioPlaybackPort,
  AudioPlaybackReceipt,
  AudioPlaybackRequest,
} from '../../features/reminder/application/interfaces';
import { buildAudioDataUri } from './audioDataUri';

type AudioStatusLike = {
  playing?: boolean;
  error?: string | null;
};

type AudioPlayerSubscription = {
  remove: () => void;
};

type AudioPlayerLike = {
  pause: () => void;
  replace: (source: string) => void;
  play: () => void;
  volume: number;
  playing?: boolean;
  addListener?: (
    eventName: 'playbackStatusUpdate',
    listener: (status: AudioStatusLike) => void,
  ) => AudioPlayerSubscription;
};

type ExpoAudioModule = {
  createAudioPlayer: (source?: string | null) => AudioPlayerLike;
  setAudioModeAsync: (mode: Record<string, unknown>) => Promise<void>;
};

const PLAYING_CONFIRM_MS = 2_000;

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
    const expoAudio = loadExpoAudio();
    if (expoAudio == null) return false;

    try {
      const modeOk = await this.ensureAudioMode(expoAudio);
      if (!modeOk) return false;

      if (this.player == null) {
        this.player = expoAudio.createAudioPlayer(null);
      }

      this.player.pause();
      this.player.replace(buildAudioDataUri(data, format));
      this.player.volume = 1;
      this.activeScheduleId = scheduleId;
      const started = this.waitUntilPlaying(this.player);
      this.player.play();
      const played = await started;
      if (this.activeScheduleId !== scheduleId) return false;
      return played;
    } catch {
      if (this.activeScheduleId === scheduleId) {
        this.activeScheduleId = null;
      }
      return false;
    }
  }

  private async ensureAudioMode(expoAudio: ExpoAudioModule): Promise<boolean> {
    if (this.modeReady == null) {
      this.modeReady = expoAudio.setAudioModeAsync({
        allowsRecording: false,
        interruptionMode: 'doNotMix',
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
    }
    try {
      await this.modeReady;
      return true;
    } catch {
      this.modeReady = null;
      return false;
    }
  }

  private waitUntilPlaying(player: AudioPlayerLike): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let subscription: AudioPlayerSubscription | undefined;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timeoutId != null) clearTimeout(timeoutId);
        subscription?.remove();
        resolve(value);
      };
      if (player.playing === true) {
        finish(true);
        return;
      }
      if (typeof player.addListener !== 'function') {
        finish(false);
        return;
      }
      timeoutId = setTimeout(() => finish(false), PLAYING_CONFIRM_MS);
      subscription = player.addListener('playbackStatusUpdate', (status) => {
        if (status?.error) {
          finish(false);
          return;
        }
        if (status?.playing === true) {
          finish(true);
        }
      });
    });
  }
}

function loadExpoAudio(): ExpoAudioModule | null {
  try {
    // Lazy require keeps Jest able to mock expo-audio without native ESM.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-audio') as {
      default?: ExpoAudioModule;
    } & Partial<ExpoAudioModule>;
    const resolved = mod.default ?? mod;
    if (typeof resolved.createAudioPlayer !== 'function') return null;
    return resolved as ExpoAudioModule;
  } catch {
    return null;
  }
}
