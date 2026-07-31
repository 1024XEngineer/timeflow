import type {
  VoiceParseReadyResult,
  VoiceParseResultMessage,
  VoiceStreamCancelCommand,
  VoiceStreamCancelAck,
  VoiceStreamEndCommand,
  VoiceStreamStartCommand,
  VoiceStreamStartResponse,
  VoiceStreamEndResponse,
  WsJsonMessage,
} from '@/contracts';
import { nextRequestId } from '@/shared/utils/requestId';

export type VoiceParseOutcome = Pick<
  VoiceParseReadyResult,
  'draft' | 'missing_fields' | 'ambiguous_fields'
>;

export type VoiceStreamPort = {
  start(): Promise<{ streamId: string; jobId: string; resultRequestId: string }>;
  sendAudioChunk(data: ArrayBuffer): void;
  end(streamId: string, jobId: string, resultRequestId: string): Promise<VoiceParseOutcome>;
  cancel(streamId: string, jobId: string | null): Promise<void>;
};

/** Composition port; concrete microphone adapters live outside the feature. */
export type VoiceRecorder = {
  start(onChunk: (chunk: ArrayBuffer) => void): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
};

/** assistant data 层所需的最小传输面；由 app 注入 WsClient。 */
export type VoiceTransport = {
  onMessage(listener: (message: WsJsonMessage | ArrayBuffer) => void): () => void;
  request<T extends WsJsonMessage>(
    message: WsJsonMessage & { request_id: string },
    isMatch?: (response: WsJsonMessage) => boolean,
  ): Promise<T>;
  sendBinary(data: ArrayBuffer): void;
};

export class WsVoiceStreamPort implements VoiceStreamPort {
  constructor(private readonly client: VoiceTransport) {}

  async start(): Promise<{ streamId: string; jobId: string; resultRequestId: string }> {
    const request: VoiceStreamStartCommand = {
      type: 'voice.stream.start',
      request_id: nextRequestId('req_voice_start'),
      payload: {
        audio_format: 'pcm_s16le',
        sample_rate_hz: 16000,
        channels: 1,
      },
    };
    const response = await this.client.request<VoiceStreamStartResponse>(request, (message) => {
      return (
        message.request_id === request.request_id &&
        (message.type === 'voice.stream.started' || message.type === 'voice.stream.error')
      );
    });
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    return {
      streamId: response.payload.stream_id,
      jobId: response.payload.job_id,
      resultRequestId: request.request_id,
    };
  }

  sendAudioChunk(data: ArrayBuffer): void {
    if (data.byteLength === 0 || data.byteLength % 2 !== 0) {
      throw new Error('PCM 音频帧不能为空且必须按 16 位采样对齐');
    }
    this.client.sendBinary(data);
  }

  async end(streamId: string, jobId: string, resultRequestId: string): Promise<VoiceParseOutcome> {
    const request: VoiceStreamEndCommand = {
      type: 'voice.stream.end',
      request_id: nextRequestId('req_voice_end'),
      payload: { stream_id: streamId },
    };

    let cleanupParseListener = () => undefined;
    const parseResult = new Promise<VoiceParseOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanupParseListener();
        reject(new Error('voice.parse.result timed out'));
      }, 20_000);
      const unsubscribe = this.client.onMessage((message: WsJsonMessage | ArrayBuffer) => {
        if (message instanceof ArrayBuffer) return;
        if (message.type !== 'voice.parse.result') return;
        const result = message as VoiceParseResultMessage;
        // The MVP backend correlates the final parse result to voice.stream.start,
        // while voice.stream.ended is correlated to this end request.
        if (result.job_id !== jobId || result.request_id !== resultRequestId) return;
        clearTimeout(timer);
        cleanupParseListener();
        if (result.status === 'failed') {
          reject(new Error(result.error.message));
          return;
        }
        resolve({
          draft: result.draft,
          missing_fields: result.missing_fields,
          ambiguous_fields: result.ambiguous_fields,
        });
      });
      cleanupParseListener = () => {
        clearTimeout(timer);
        unsubscribe();
      };
    });

    let endResponse: VoiceStreamEndResponse;
    try {
      endResponse = await this.client.request<VoiceStreamEndResponse>(request, (message) => {
        return (
          message.request_id === request.request_id &&
          (message.type === 'voice.stream.ended' || message.type === 'voice.stream.error')
        );
      });
    } catch (error) {
      cleanupParseListener();
      throw error;
    }
    if (!endResponse.ok) {
      cleanupParseListener();
      throw new Error(endResponse.error.message);
    }
    return parseResult;
  }

  async cancel(streamId: string, jobId: string | null): Promise<void> {
    const request: VoiceStreamCancelCommand = {
      type: 'voice.stream.cancel',
      request_id: nextRequestId('req_voice_cancel'),
      payload: { stream_id: streamId, job_id: jobId },
    };
    const response = await this.client.request<VoiceStreamCancelAck>(request, (message) => {
      return (
        message.request_id === request.request_id &&
        (message.type === 'voice.stream.cancelled' ||
          message.type === 'voice.stream.error' ||
          message.type === 'voice.stream.cancel')
      );
    });
    if (!response.ok) {
      throw new Error(response.error.message);
    }
  }
}
