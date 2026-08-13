/**
 * TTS 回复的流式播放端口。与 reminder 域的 AudioPlaybackPort 不同：那边播的是
 * 已经生成好的一整段提醒音频，这里播的是 voice.tts.start 之后陆续到达、还没
 * 收全的 PCM 分片，必须边收边放，不能等 voice.tts.end 才开始。
 */
export interface AssistantAudioPlaybackPort {
  startStream(format: { sampleRateHz: number; encoding: 'pcm_s16le' }): Promise<void>;
  pushChunk(chunk: ArrayBuffer): Promise<void>;
  endStream(): Promise<void>;
  /** 立即打断正在播放的内容，不等 voice.tts.end——用户主动关掉回复气泡时用。 */
  stop(): Promise<void>;
}
