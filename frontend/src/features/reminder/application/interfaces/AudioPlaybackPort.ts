export type AudioPlaybackRequest = {
  schedule_id: string;
  audio_id?: string;
  format?: string;
  data?: Uint8Array;
};

export type AudioPlaybackReceipt = {
  playback_id: string;
  played: boolean;
  used_local_fallback: boolean;
};

/** 只播放已经生成的音频；此端口不负责语音合成。 */
export interface AudioPlaybackPort {
  isTtsAvailable(): Promise<boolean>;
  playTts(request: AudioPlaybackRequest): Promise<AudioPlaybackReceipt>;
  playLocalFallback(request: AudioPlaybackRequest): Promise<AudioPlaybackReceipt>;
  stop(scheduleId: string): Promise<void>;
}
