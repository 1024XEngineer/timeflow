import type {
  AssistantClientMessage,
  AssistantServerMessage,
} from '../../../../contracts/conversation';

/** 打开一个已握手的 WS 连接。真实实现见 data/websocket；测试用脚本化的假连接替换。 */
export interface VoiceTransportPort {
  connect(url: string): Promise<VoiceTransportConnection>;
}

/** 一条已连接的会话。上层只发消息、收消息，不关心底层是文本帧还是二进制帧。 */
export interface VoiceTransportConnection {
  send(message: AssistantClientMessage): void;
  sendAudioFrame(chunk: ArrayBuffer): void;
  /** 返回取消订阅函数，调用方负责在自己销毁时调用。 */
  onMessage(handler: (message: AssistantServerMessage) => void): () => void;
  /** 服务端推来的二进制帧（TTS 回复音频），与 JSON 控制消息分开一条通道。 */
  onAudioFrame(handler: (chunk: ArrayBuffer) => void): () => void;
  onClose(handler: (event: { code: number; reason: string }) => void): () => void;
  close(): void;
}
