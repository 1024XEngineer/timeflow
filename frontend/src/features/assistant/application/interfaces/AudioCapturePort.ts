/**
 * 麦克风采集端口。协议要求 16kHz 单声道 pcm_s16le，逐帧发送、无逐帧 ACK
 * （AGENTS.md 第 6 节），所以这里是"边录边回调"而不是"录完给文件"。
 */
export interface AudioCapturePort {
  /** 请求麦克风权限，返回是否已获得。 */
  requestPermission(): Promise<boolean>;
  /**
   * 开始采集；onChunk 在每个 PCM 分片就绪时触发，直到 stop() 被调用。
   * soundLevel 是这一帧的音量（dBFS，通常 -160~0），拿不到时传 null——给录音中
   * 的波形展示用，不是协议必需的。
   */
  start(onChunk: (chunk: ArrayBuffer, soundLevel: number | null) => void): Promise<void>;
  stop(): Promise<void>;
}
