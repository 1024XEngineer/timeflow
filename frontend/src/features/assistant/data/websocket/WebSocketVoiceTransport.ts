import type { AssistantServerMessage } from '../../../../contracts/conversation';
import type {
  VoiceTransportConnection,
  VoiceTransportPort,
} from '../../application/interfaces/VoiceTransportPort';

/**
 * RN 全局 WebSocket 的真实实现。二进制帧走 arraybuffer（RN 不支持浏览器的
 * AudioWorklet 那套，但 WebSocket 本身的二进制收发是一致的），JSON
 * 控制消息按文本帧收发，两条通道在 message 事件里按 typeof event.data 区分。
 */
export class WebSocketVoiceTransport implements VoiceTransportPort {
  connect(url: string): Promise<VoiceTransportConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';

      const messageHandlers = new Set<(message: AssistantServerMessage) => void>();
      const audioHandlers = new Set<(chunk: ArrayBuffer) => void>();
      const closeHandlers = new Set<(event: { code: number; reason: string }) => void>();

      socket.onopen = () => {
        resolve({
          close: () => socket.close(),
          onAudioFrame: (handler) => {
            audioHandlers.add(handler);
            return () => audioHandlers.delete(handler);
          },
          onClose: (handler) => {
            closeHandlers.add(handler);
            return () => closeHandlers.delete(handler);
          },
          onMessage: (handler) => {
            messageHandlers.add(handler);
            return () => messageHandlers.delete(handler);
          },
          send: (message) => socket.send(JSON.stringify(message)),
          sendAudioFrame: (chunk) => socket.send(chunk),
        });
      };

      socket.onerror = () => reject(new Error(`无法连接语音服务：${url}`));

      socket.onmessage = (event: WebSocketMessageEvent) => {
        if (typeof event.data === 'string') {
          const parsed = JSON.parse(event.data) as AssistantServerMessage;
          for (const handler of messageHandlers) {
            handler(parsed);
          }
          return;
        }
        const chunk = event.data as ArrayBuffer;
        for (const handler of audioHandlers) {
          handler(chunk);
        }
      };

      socket.onclose = (event: WebSocketCloseEvent) => {
        for (const handler of closeHandlers) {
          handler({ code: event.code ?? 0, reason: event.reason ?? '' });
        }
      };
    });
  }
}
