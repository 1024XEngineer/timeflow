import { useCallback, useEffect, useMemo, useState } from 'react';

import { useOverlay } from '@/app/overlay/OverlayProvider';
import { useLocationReporting } from '@/app/integrations/useLocationReporting';
import { useSession } from '@/app/session/SessionProvider';
import { createVoiceRecorder } from '@/infrastructure/audio/VoiceRecorder';
import {
  AssistantChatSheet,
  AssistantDock,
  useAssistantSession,
  type VoiceRecorder,
} from '@/features/assistant';
import {
  StandardCreateModal,
  ScheduleScreen,
  scheduleDraftFromVoiceParse,
  upsertDraftForSchedule,
  useSessionSavedLocations,
  useScheduleCommands,
  type Schedule,
  type ScheduleDraft,
} from '@/features/schedule';
import type { LocationProvider } from '@/app/integrations/useLocationReporting';
import { useAppDialog } from '@/shared/components/AppDialogProvider';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * App 组合根：接线 schedule 与 assistant，feature 之间不互相 import。
 */
export function AppShell({
  locationProvider,
  voiceRecorder: injectedVoiceRecorder,
}: {
  locationProvider?: LocationProvider;
  voiceRecorder?: VoiceRecorder;
} = {}) {
  const { isOpen, push, popKind } = useOverlay();
  const { showNotice } = useAppDialog();
  const { client, connectionStatus, connectionError } = useSession();
  const {
    items: scheduleItems,
    ready,
    saveDraft,
    toggleScheduleDone,
    deleteSchedule,
    mutation,
  } = useScheduleCommands();
  useLocationReporting({
    client,
    connectionStatus,
    items: scheduleItems,
    provider: locationProvider,
  });

  const [editingDraft, setEditingDraft] = useState<ScheduleDraft | null>(null);
  const voiceRecorder = useMemo(
    () => injectedVoiceRecorder ?? createVoiceRecorder(),
    [injectedVoiceRecorder],
  );
  const { locations: savedLocations, upsert: upsertLocation } = useSessionSavedLocations();
  const standardCreateOpen = isOpen('standardCreate');
  const assistantOpen = isOpen('assistant');

  useEffect(() => {
    if (connectionError) {
      void showNotice({ title: '连接不可用', message: connectionError });
    }
  }, [connectionError, showNotice]);

  useEffect(() => {
    if (mutation.status === 'error' && mutation.error) {
      void showNotice({ title: '操作失败', message: mutation.error });
    }
  }, [mutation.error, mutation.status, showNotice]);

  const closeStandardCreate = useCallback(() => {
    setEditingDraft(null);
    popKind('standardCreate');
  }, [popKind]);

  const openStandardCreate = useCallback(
    (draft: ScheduleDraft | null = null) => {
      if (!ready) {
        void showNotice({ title: '日程服务未就绪', message: '请稍后重试' });
        return;
      }
      setEditingDraft(draft);
      if (!isOpen('standardCreate')) {
        push({
          kind: 'standardCreate',
          onClose: () => setEditingDraft(null),
        });
      }
    },
    [isOpen, push, ready, showNotice],
  );

  const editSchedule = useCallback(
    (item: Schedule) => {
      openStandardCreate(upsertDraftForSchedule(item));
    },
    [openStandardCreate],
  );

  const saveStandardDraft = useCallback(
    async (draft: ScheduleDraft) => {
      await saveDraft(draft);
      closeStandardCreate();
    },
    [closeStandardCreate, saveDraft],
  );

  const openAssistant = useCallback(() => {
    if (!isOpen('assistant')) push({ kind: 'assistant' });
  }, [isOpen, push]);

  const closeAssistant = useCallback(() => {
    popKind('assistant');
  }, [popKind]);

  const assistant = useAssistantSession({
    client,
    onConfirmDraft: async (voiceDraft) => {
      await saveDraft(scheduleDraftFromVoiceParse(voiceDraft));
    },
    recorder: voiceRecorder,
  });

  const handleVoiceStart = useCallback(() => {
    void assistant
      .handleVoiceStart()
      .catch((error) => showNotice({ title: '语音启动失败', message: errorMessage(error) }));
  }, [assistant, showNotice]);

  const handleVoiceEnd = useCallback(async () => {
    openAssistant();
    try {
      await assistant.handleVoiceEnd();
    } catch (error) {
      await showNotice({ title: '语音解析失败', message: errorMessage(error) });
    }
  }, [assistant, openAssistant, showNotice]);

  const onVoiceEnd = useCallback(() => {
    void handleVoiceEnd();
  }, [handleVoiceEnd]);

  const onDeleteSchedule = useCallback(
    (item: Schedule) => {
      void deleteSchedule(item).catch(() => undefined);
    },
    [deleteSchedule],
  );

  const onToggleSchedule = useCallback(
    (item: Schedule) => {
      void toggleScheduleDone(item).catch(() => undefined);
    },
    [toggleScheduleDone],
  );

  return (
    <>
      <ScheduleScreen
        canMutate={ready}
        onCreate={() => openStandardCreate()}
        onDeleteSchedule={onDeleteSchedule}
        onEditSchedule={editSchedule}
        onToggleSchedule={onToggleSchedule}
        scheduleItems={scheduleItems}
      />

      <AssistantChatSheet
        isProcessing={assistant.isProcessing}
        messages={assistant.messages}
        onAction={(messageId, action) => {
          void assistant.handleAction(messageId, action).catch((error) => {
            void showNotice({ title: '助手操作失败', message: errorMessage(error) });
          });
        }}
        onClose={closeAssistant}
        onVoiceCancel={assistant.handleVoiceCancel}
        onVoiceEnd={onVoiceEnd}
        onVoiceStart={handleVoiceStart}
        visible={assistantOpen}
      />
      <AssistantDock
        hidden={assistantOpen}
        onOpen={openAssistant}
        onVoiceCancel={assistant.handleVoiceCancel}
        onVoiceEnd={onVoiceEnd}
        onVoiceStart={handleVoiceStart}
      />

      <StandardCreateModal
        initialDraft={editingDraft}
        onClose={closeStandardCreate}
        onSave={saveStandardDraft}
        onUpsertLocation={upsertLocation}
        savedLocations={savedLocations}
        visible={standardCreateOpen}
      />
    </>
  );
}
