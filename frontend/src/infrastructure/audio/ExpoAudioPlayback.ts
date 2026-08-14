import type {
  AudioPlaybackPort,
  AudioPlaybackReceipt,
  AudioPlaybackRequest,
} from '../../features/reminder/application/interfaces';
import { buildAudioDataUri } from './audioDataUri';

// Metro 资源 id；高强度本地兜底铃声（与原生 AlarmSoundService 同源）。
const LOCAL_ALARM_SOUND = require('../../../assets/sounds/alarm_prompt.mp3') as number;

type AudioPlayerLike = {
  pause: () => void;
  replace: (source: string | number) => void;
  play: () => void;
  volume: number;
  loop: boolean;
};

type ExpoAudioModule = {
  createAudioPlayer: (source?: string | number | null) => AudioPlayerLike;
  setAudioModeAsync: (mode: Record<string, unknown>) => Promise<void>;
};

/**
 * 音频播放适配器：
 * - TTS 有字节时播放并循环，直到 stop
 * - 否则播放打包的 alarm_prompt.mp3（高强度本地兜底）
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

    const played = await this.playBundledAlarm(request.schedule_id);
    return {
      playback_id: `local-bundled-${request.schedule_id}`,
      played,
      used_local_fallback: true,
    };
  }

  async stop(scheduleId: string): Promise<void> {
    if (this.activeScheduleId !== scheduleId) return;
    if (this.player != null) {
      this.player.loop = false;
      this.player.pause();
    }
    this.activeScheduleId = null;
  }

  private async playBytes(scheduleId: string, data: Uint8Array, format: string): Promise<boolean> {
    const expoAudio = await loadExpoAudio();
    if (expoAudio == null) return false;

    await this.ensureAudioMode(expoAudio);
    const player = this.ensurePlayer(expoAudio);
    player.pause();
    player.replace(buildAudioDataUri(data, format));
    player.loop = true;
    player.volume = 1;
    this.activeScheduleId = scheduleId;
    player.play();
    return true;
  }

  private async playBundledAlarm(scheduleId: string): Promise<boolean> {
    const expoAudio = await loadExpoAudio();
    if (expoAudio == null) return false;

    await this.ensureAudioMode(expoAudio);
    const player = this.ensurePlayer(expoAudio);
    player.pause();
    player.replace(LOCAL_ALARM_SOUND);
    player.loop = true;
    player.volume = 1;
    this.activeScheduleId = scheduleId;
    player.play();
    return true;
  }

  private ensurePlayer(expoAudio: ExpoAudioModule): AudioPlayerLike {
    if (this.player == null) {
      this.player = expoAudio.createAudioPlayer(null);
    }
    return this.player;
  }

  private async ensureAudioMode(expoAudio: ExpoAudioModule): Promise<void> {
    if (this.modeReady == null) {
      this.modeReady = expoAudio
        .setAudioModeAsync({
          allowsRecording: false,
          interruptionMode: 'doNotMix',
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          shouldRouteThroughEarpiece: false,
        })
        .catch(() => undefined);
    }
    await this.modeReady;
  }
}

async function loadExpoAudio(): Promise<ExpoAudioModule | null> {
  try {
    const mod = await import('expo-audio');
    if (typeof mod.createAudioPlayer !== 'function') return null;
    return mod as unknown as ExpoAudioModule;
  } catch {
    return null;
  }
}
