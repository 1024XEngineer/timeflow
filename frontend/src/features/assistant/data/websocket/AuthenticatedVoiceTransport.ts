import type { AssistantServerMessage } from '../../../../contracts/conversation';
import type { AuthenticatedWebSocketClient } from '../../../../infrastructure/websocket';
import type { LocationSample } from '../../../reminder/domain';
import type {
  VoiceTransportConnection,
  VoiceTransportPort,
} from '../../application/interfaces/VoiceTransportPort';

/**
 * 语音这条连接不再自己做 session.hello/session.ready 握手——那套时序、超时、
 * request_id 校验、鉴权失效协调都由应用唯一的 AuthenticatedWebSocketClient
 * 负责（跟 HTTP 那条认证链路共用同一份失效逻辑）。这里只是一层适配：把它
 * ready 之后统一的 string|ArrayBuffer 通道，按语音协议拆成 JSON 控制消息和
 * 二进制音频两条，喂给上层的 VoiceTransportConnection 接口。
 *
 * close() 只解绑这一路监听，不关共享连接——连接的生命周期归认证系统管
 * （token 失效时 AuthInvalidationCoordinator 会关），语音只是众多使用方之一。
 */
export class AuthenticatedVoiceTransport implements VoiceTransportPort {
  constructor(private readonly client: AuthenticatedWebSocketClient) {}

  async connect(location?: LocationSample | null): Promise<VoiceTransportConnection> {
    await this.client.connect(
      location ? { latitude: location.latitude, longitude: location.longitude } : undefined,
    );

    const messageHandlers = new Set<(message: AssistantServerMessage) => void>();
    const audioHandlers = new Set<(chunk: ArrayBuffer) => void>();

    const unsubscribeMessages = this.client.subscribe((data) => {
      if (typeof data === 'string') {
        const parsed = JSON.parse(data) as AssistantServerMessage;
        for (const handler of messageHandlers) {
          handler(parsed);
        }
        return;
      }
      for (const handler of audioHandlers) {
        handler(data);
      }
    });

    return {
      close: () => {
        unsubscribeMessages();
      },
      onAudioFrame: (handler) => {
        audioHandlers.add(handler);
        return () => audioHandlers.delete(handler);
      },
      onClose: (handler) => this.client.onClose(handler),
      onMessage: (handler) => {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      send: (message) => this.client.send(JSON.stringify(message)),
      sendAudioFrame: (chunk) => this.client.send(chunk),
    };
  }
}
