import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { VoiceParseDraft } from '@/contracts';

import {
  WsVoiceStreamPort,
  type VoiceRecorder,
  type VoiceParseOutcome,
  type VoiceStreamPort,
  type VoiceTransport,
} from '../data/VoiceStreamPort';
import type { AssistantMessage, AssistantMessageAction } from '../types';

function formatWhenLabel(draft: VoiceParseDraft): string {
  if (draft.start_time) {
    const date = new Date(draft.start_time);
    if (!Number.isNaN(date.getTime())) {
      return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
  }
  if (draft.location_name || draft.location_address) {
    return draft.location_name ?? draft.location_address ?? '地点提醒';
  }
  return '待确认时间';
}

const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  schedule_type: '提醒类型',
  start_time: '开始时间',
  end_time: '结束时间',
  location_name: '地点名称',
  location_address: '地点地址',
};

function formatFieldName(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function formatClarificationLabel(result: VoiceParseOutcome): string | undefined {
  const missing = result.missing_fields.map(formatFieldName);
  const ambiguous = result.ambiguous_fields.map(formatFieldName);
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`需要补充：${missing.join('、')}`);
  if (ambiguous.length > 0) parts.push(`需要确认：${ambiguous.join('、')}`);
  return parts.length > 0 ? parts.join('；') : undefined;
}

type ActiveVoiceStream = {
  streamId: string;
  jobId: string;
  resultRequestId: string;
  port: VoiceStreamPort;
  recorder: VoiceRecorder;
  hasAudio: boolean;
};

async function cancelVoiceStream(stream: ActiveVoiceStream): Promise<void> {
  await stream.recorder.cancel().catch(() => undefined);
  await stream.port.cancel(stream.streamId, stream.jobId).catch(() => undefined);
}

/**
 * 助手会话：只产出 VoiceParseDraft，不依赖 schedule model。
 * AppShell 负责映射为 ScheduleDraft 并写入日程。
 */
export function useAssistantSession(options: {
  client: VoiceTransport | null;
  onConfirmDraft: (draft: VoiceParseDraft) => Promise<void>;
  /** The app host must inject a production PCM recorder for its platform. */
  recorder: VoiceRecorder;
}) {
  const voice = useMemo(
    () => (options.client ? new WsVoiceStreamPort(options.client) : null),
    [options.client],
  );
  const recorder = options.recorder;
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const activeStreamRef = useRef<ActiveVoiceStream | null>(null);
  const startPromiseRef = useRef<Promise<ActiveVoiceStream> | null>(null);
  const [pendingDrafts, setPendingDrafts] = useState<Record<string, VoiceParseOutcome>>({});

  useEffect(() => {
    return () => {
      const cancel = (stream: ActiveVoiceStream) => {
        if (activeStreamRef.current === stream) activeStreamRef.current = null;
        void cancelVoiceStream(stream);
      };
      const starting = startPromiseRef.current;
      if (starting) {
        void starting.then(cancel).catch(() => undefined);
        return;
      }
      const stream = activeStreamRef.current;
      if (stream) cancel(stream);
    };
  }, []);

  const handleVoiceStart = useCallback(async () => {
    if (!voice) throw new Error('语音通道未就绪');
    if (activeStreamRef.current || startPromiseRef.current) {
      throw new Error('语音录音已经开始');
    }

    const startOperation = (async (): Promise<ActiveVoiceStream> => {
      const started = await voice.start();
      const stream: ActiveVoiceStream = { ...started, port: voice, recorder, hasAudio: false };
      try {
        await recorder.start((chunk) => {
          voice.sendAudioChunk(chunk);
          stream.hasAudio = true;
        });
      } catch (error) {
        await voice.cancel(started.streamId, started.jobId).catch(() => undefined);
        throw error;
      }
      activeStreamRef.current = stream;
      return stream;
    })();
    startPromiseRef.current = startOperation;
    try {
      await startOperation;
    } finally {
      if (startPromiseRef.current === startOperation) {
        startPromiseRef.current = null;
      }
    }
  }, [recorder, voice]);

  const handleVoiceEnd = useCallback(async () => {
    const starting = startPromiseRef.current;
    if (starting) {
      try {
        await starting;
      } catch {
        // handleVoiceStart owns reporting its startup failure.
        return;
      }
    }
    const stream = activeStreamRef.current;
    if (!stream) return;
    activeStreamRef.current = null;
    setIsProcessing(true);
    try {
      try {
        await stream.recorder.stop();
      } catch (error) {
        await stream.port.cancel(stream.streamId, stream.jobId).catch(() => undefined);
        throw error;
      }
      if (!stream.hasAudio) {
        await stream.port.cancel(stream.streamId, stream.jobId).catch(() => undefined);
        return;
      }
      const parseResult = await stream.port.end(
        stream.streamId,
        stream.jobId,
        stream.resultRequestId,
      );
      const messageId = `msg_${Date.now()}`;
      const clarificationLabel = formatClarificationLabel(parseResult);
      const canConfirm = !clarificationLabel;
      setPendingDrafts((current) => ({ ...current, [messageId]: parseResult }));
      setMessages((current) => [
        ...current,
        {
          id: messageId,
          role: 'assistant',
          createdAt: Date.now(),
          draft: {
            title: parseResult.draft.title,
            whenLabel: formatWhenLabel(parseResult.draft),
            metaLabel: parseResult.draft.location_name ?? undefined,
            clarificationLabel,
            state: 'pending',
          },
          actions: canConfirm
            ? [
                { id: `${messageId}_confirm`, label: '确认添加', kind: 'confirm' },
                { id: `${messageId}_dismiss`, label: '忽略', kind: 'dismiss' },
              ]
            : [{ id: `${messageId}_dismiss`, label: '忽略', kind: 'dismiss' }],
        },
      ]);
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const handleVoiceCancel = useCallback(() => {
    setIsProcessing(false);
    const cancel = (stream: ActiveVoiceStream) => {
      if (activeStreamRef.current === stream) activeStreamRef.current = null;
      return cancelVoiceStream(stream);
    };

    const starting = startPromiseRef.current;
    if (starting) {
      void starting.then(cancel).catch(() => undefined);
      return;
    }
    const stream = activeStreamRef.current;
    if (stream) void cancel(stream);
  }, []);

  const handleAction = useCallback(
    async (messageId: string, action: AssistantMessageAction) => {
      if (action.kind === 'confirm') {
        const result = pendingDrafts[messageId];
        if (!result) return;
        if (result.missing_fields.length > 0 || result.ambiguous_fields.length > 0) {
          throw new Error('语音草稿仍有待确认字段，不能直接加入日程');
        }
        await options.onConfirmDraft(result.draft);
      }
      setPendingDrafts((current) => {
        const next = { ...current };
        delete next[messageId];
        return next;
      });
      setMessages((current) =>
        current.map((item) =>
          item.id === messageId && item.draft
            ? {
                ...item,
                actions: undefined,
                draft: {
                  ...item.draft,
                  state: action.kind === 'confirm' ? 'added' : 'dismissed',
                },
              }
            : item,
        ),
      );
    },
    [options, pendingDrafts],
  );

  return {
    messages,
    isProcessing,
    handleVoiceStart,
    handleVoiceEnd,
    handleVoiceCancel,
    handleAction,
  };
}
