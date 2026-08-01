import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type { WsJsonMessage } from '@/contracts';
import type { VoiceRecorder, VoiceTransport } from '@/features/assistant/data/VoiceStreamPort';
import { useAssistantSession } from '@/features/assistant/hooks/useAssistantSession';

function createVoiceTransport(options: {
  missingFields?: string[];
  ambiguousFields?: string[];
  startGate?: Promise<void>;
}): VoiceTransport {
  const listeners = new Set<(message: WsJsonMessage | ArrayBuffer) => void>();
  let resultRequestId = '';

  return {
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request<T extends WsJsonMessage>(message: WsJsonMessage & { request_id: string }) {
      if (message.type === 'voice.stream.start') {
        await options.startGate;
        resultRequestId = message.request_id;
        return {
          type: 'voice.stream.started',
          request_id: message.request_id,
          ok: true,
          payload: { stream_id: 'stream_1', job_id: 'job_1' },
        } as unknown as T;
      }
      if (message.type === 'voice.stream.end') {
        const parseResult: WsJsonMessage = {
          type: 'voice.parse.result',
          request_id: resultRequestId,
          job_id: 'job_1',
          status: 'ready_for_confirmation',
          draft: {
            schedule_type: 'time',
            title: '语音日程',
            start_time: null,
          },
          missing_fields: options.missingFields ?? [],
          ambiguous_fields: options.ambiguousFields ?? [],
          needs_confirmation: true,
        };
        for (const listener of listeners) listener(parseResult);
        return {
          type: 'voice.stream.ended',
          request_id: message.request_id,
          ok: true,
          payload: { stream_id: 'stream_1', job_id: 'job_1', status: 'processing' },
        } as unknown as T;
      }
      return {
        type: 'voice.stream.cancelled',
        request_id: message.request_id,
        ok: true,
        payload: { stream_id: 'stream_1' },
      } as unknown as T;
    },
    sendBinary() {},
  };
}

const recorder: VoiceRecorder = {
  async start(onChunk) {
    onChunk(new ArrayBuffer(2));
  },
  async stop() {},
  async cancel() {},
};

describe('useAssistantSession', () => {
  it('keeps incomplete parse metadata and does not offer direct confirmation', async () => {
    const onConfirmDraft = jest.fn(async () => undefined);
    const { result } = renderHook(() =>
      useAssistantSession({
        client: createVoiceTransport({
          missingFields: ['start_time'],
          ambiguousFields: ['title'],
        }),
        onConfirmDraft,
        recorder,
      }),
    );

    await act(async () => {
      await result.current.handleVoiceStart();
    });
    await act(async () => {
      await result.current.handleVoiceEnd();
    });

    const message = result.current.messages[0];
    expect(message?.draft?.clarificationLabel).toBe('需要补充：开始时间；需要确认：标题');
    expect(message?.actions?.map((action) => action.kind)).toEqual(['dismiss']);
    expect(onConfirmDraft).not.toHaveBeenCalled();
  });

  it('offers confirmation when the parsed draft is complete', async () => {
    const onConfirmDraft = jest.fn(async () => undefined);
    const { result } = renderHook(() =>
      useAssistantSession({
        client: createVoiceTransport({}),
        onConfirmDraft,
        recorder,
      }),
    );

    await act(async () => {
      await result.current.handleVoiceStart();
    });
    await act(async () => {
      await result.current.handleVoiceEnd();
    });

    const message = result.current.messages[0];
    const confirm = message?.actions?.find((action) => action.kind === 'confirm');
    expect(confirm).toBeDefined();

    await act(async () => {
      await result.current.handleAction(message!.id, confirm!);
    });
    expect(onConfirmDraft).toHaveBeenCalledTimes(1);
    expect(result.current.messages[0]?.draft?.state).toBe('added');
  });

  it('waits for an in-flight start when the user releases immediately', async () => {
    let releaseStart: () => void = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { result } = renderHook(() =>
      useAssistantSession({
        client: createVoiceTransport({ startGate }),
        onConfirmDraft: async () => undefined,
        recorder,
      }),
    );

    let starting!: Promise<void>;
    let ending!: Promise<void>;
    act(() => {
      starting = result.current.handleVoiceStart();
      ending = result.current.handleVoiceEnd();
    });

    await act(async () => {
      releaseStart();
      await Promise.all([starting, ending]);
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.draft?.title).toBe('语音日程');
  });

  it('reports processing while waiting for the final parse result', async () => {
    let releaseEnd: () => void = () => undefined;
    const listeners = new Set<(message: WsJsonMessage | ArrayBuffer) => void>();
    let startRequestId = '';
    const client: VoiceTransport = {
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async request<T extends WsJsonMessage>(message: WsJsonMessage & { request_id: string }) {
        if (message.type === 'voice.stream.start') {
          startRequestId = message.request_id;
          return {
            type: 'voice.stream.started',
            request_id: message.request_id,
            ok: true,
            payload: { stream_id: 'stream_1', job_id: 'job_1' },
          } as unknown as T;
        }
        await new Promise<void>((resolve) => {
          releaseEnd = resolve;
        });
        for (const listener of listeners) {
          listener({
            type: 'voice.parse.result',
            request_id: startRequestId,
            job_id: 'job_1',
            status: 'ready_for_confirmation',
            draft: { schedule_type: 'time', title: '语音日程', start_time: null },
            missing_fields: [],
            ambiguous_fields: [],
            needs_confirmation: true,
          });
        }
        return {
          type: 'voice.stream.ended',
          request_id: message.request_id,
          ok: true,
          payload: { stream_id: 'stream_1', job_id: 'job_1', status: 'processing' },
        } as unknown as T;
      },
      sendBinary() {},
    };
    const { result } = renderHook(() =>
      useAssistantSession({ client, onConfirmDraft: async () => undefined, recorder }),
    );
    await act(async () => {
      await result.current.handleVoiceStart();
    });

    let ending!: Promise<void>;
    act(() => {
      ending = result.current.handleVoiceEnd();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isProcessing).toBe(true);

    await act(async () => {
      releaseEnd();
      await ending;
    });
    expect(result.current.isProcessing).toBe(false);
  });

  it('cancels without parsing when the recorder produced no audio', async () => {
    const client = createVoiceTransport({});
    const request = jest.spyOn(client, 'request');
    const silentRecorder: VoiceRecorder = {
      async start() {},
      async stop() {},
      async cancel() {},
    };
    const { result } = renderHook(() =>
      useAssistantSession({
        client,
        onConfirmDraft: async () => undefined,
        recorder: silentRecorder,
      }),
    );

    await act(async () => {
      await result.current.handleVoiceStart();
      await result.current.handleVoiceEnd();
    });

    const requestTypes = request.mock.calls.map(([message]) => message.type);
    expect(requestTypes).toEqual(['voice.stream.start', 'voice.stream.cancel']);
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.isProcessing).toBe(false);
  });
});
