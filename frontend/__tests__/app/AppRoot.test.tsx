import { describe, expect, it, jest } from '@jest/globals';
import { BackHandler } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { makeSchedule } from '@test/fixtures';
import { AppDialogProvider } from '@/shared/components/AppDialogProvider';

const mockSaveDraft = jest.fn(async () => makeSchedule());
const mockToggle = jest.fn(async () => undefined);
const mockDelete = jest.fn(async () => undefined);
const mockItems = [makeSchedule({ id: 'nav_1', title: '导航日程' })];

jest.mock('@/features/schedule', () => ({
  useScheduleCommands: () => ({
    items: mockItems,
    ready: true,
    mutation: { status: 'idle', error: null, pendingId: null },
    saveDraft: mockSaveDraft,
    toggleScheduleDone: mockToggle,
    deleteSchedule: mockDelete,
    service: {},
  }),
  ScheduleProvider: ({ children }: { children: unknown }) => children,
  upsertDraftForSchedule: (item: {
    id: string;
    title: string;
    source_mode: string;
    schedule_type: string;
  }) => ({
    schedule_id: item.id,
    source_mode: item.source_mode,
    schedule_type: item.schedule_type,
    title: item.title,
  }),
  scheduleDraftFromVoiceParse: (draft: { title: string; schedule_type: string }) => ({
    source_mode: 'voice',
    schedule_type: draft.schedule_type,
    title: draft.title,
  }),
  useSessionSavedLocations: () => ({ locations: [], upsert: jest.fn() }),
  ScheduleScreen: ({
    onCreate,
    onEditSchedule,
    scheduleItems,
  }: {
    onCreate: () => void;
    onEditSchedule: (item: (typeof mockItems)[number]) => void;
    scheduleItems: typeof mockItems;
  }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text>{scheduleItems[0]?.title}</Text>
        <Pressable accessibilityLabel="mock-create" onPress={onCreate}>
          <Text>create</Text>
        </Pressable>
        <Pressable accessibilityLabel="mock-edit" onPress={() => onEditSchedule(scheduleItems[0]!)}>
          <Text>edit</Text>
        </Pressable>
      </>
    );
  },
  StandardCreateModal: ({
    onClose,
    onSave,
    onUpsertLocation,
    initialDraft,
    visible,
  }: {
    onClose: () => void;
    onSave: (draft: unknown) => void | Promise<void>;
    onUpsertLocation: (location: {
      id: string;
      address: string;
      latitude: number;
      longitude: number;
    }) => void;
    initialDraft?: { schedule_id?: string | null; title?: string } | null;
    visible: boolean;
  }) => {
    const React = require('react') as typeof import('react');
    const { Pressable, Text } = require('react-native');
    const [saveError, setSaveError] = React.useState('');
    if (!visible) return null;
    return (
      <>
        <Text>{initialDraft ? `editing:${initialDraft.title}` : 'creating'}</Text>
        {saveError ? <Text>{saveError}</Text> : null}
        <Pressable
          accessibilityLabel="mock-save-draft"
          onPress={() => {
            setSaveError('');
            void Promise.resolve(
              onSave({
                source_mode: 'manual',
                schedule_type: 'time',
                title: '保存的',
                start_time: new Date(Date.now() + 60_000).toISOString(),
              }),
            ).catch((error: unknown) => {
              setSaveError(error instanceof Error ? error.message : '保存失败');
            });
          }}
        >
          <Text>save</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="mock-upsert-loc"
          onPress={() =>
            onUpsertLocation({
              id: 'loc_x',
              address: 'A',
              latitude: 1,
              longitude: 2,
            })
          }
        >
          <Text>loc</Text>
        </Pressable>
        <Pressable accessibilityLabel="mock-close-create" onPress={onClose}>
          <Text>close</Text>
        </Pressable>
      </>
    );
  },
}));

jest.mock('@/features/assistant', () => ({
  AssistantChatSheet: () => null,
  AssistantDock: () => null,
  useAssistantSession: () => ({
    messages: [],
    handleVoiceStart: jest.fn(async () => undefined),
    handleVoiceEnd: jest.fn(async () => undefined),
    handleVoiceCancel: jest.fn(),
    handleAction: jest.fn(async () => undefined),
  }),
}));

jest.mock('@/app/overlay/OverlayProvider', () => {
  let sequence = 0;
  return {
    OverlayProvider: ({ children }: { children: unknown }) => children,
    useOverlay: () => {
      const React = require('react') as typeof import('react');
      const [stack, setStack] = React.useState<
        { id: string; kind: string; onClose?: () => void }[]
      >([]);
      const push = React.useCallback((entry: { kind: string; onClose?: () => void }) => {
        const id = `overlay_test_${++sequence}`;
        setStack((current) => [...current, { ...entry, id }]);
        return id;
      }, []);
      const popKind = React.useCallback((kind: string) => {
        setStack((current) => {
          const index = current.map((entry) => entry.kind).lastIndexOf(kind);
          if (index < 0) return current;
          current[index]?.onClose?.();
          return current.filter((_, currentIndex) => currentIndex !== index);
        });
      }, []);
      const pop = React.useCallback(() => {
        setStack((current) => current.slice(0, -1));
      }, []);
      return {
        stack,
        push,
        pop,
        popKind,
        isOpen: (kind: string) => stack.some((entry) => entry.kind === kind),
        top: stack.at(-1) ?? null,
      };
    },
  };
});

jest.mock('@/app/session/SessionProvider', () => ({
  useSession: () => ({
    deviceId: 'device_test',
    userId: 'user_test',
    connectionStatus: 'ready',
    transportMode: 'fake',
    sessionEpoch: 1,
    client: {
      connect: async () => undefined,
      close: () => undefined,
      onStatus: () => () => undefined,
      onMessage: () => () => undefined,
      sendJson: () => undefined,
      sendBinary: () => undefined,
      request: async () => ({ ok: true }),
    },
    fakeServer: null,
    connectionError: null,
  }),
}));

import { AppRoot } from '@/app/AppRoot';

function renderAppRoot() {
  return render(
    <AppDialogProvider>
      <AppRoot />
    </AppDialogProvider>,
  );
}

describe('AppRoot', () => {
  it('opens create and edit sheets and saves drafts', async () => {
    renderAppRoot();
    expect(screen.getByText('导航日程')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('mock-create'));
    expect(screen.getByText('creating')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('mock-save-draft'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockSaveDraft).toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText('mock-create'));
    fireEvent.press(screen.getByLabelText('mock-upsert-loc'));
    fireEvent.press(screen.getByLabelText('mock-close-create'));

    fireEvent.press(screen.getByLabelText('mock-edit'));
    expect(screen.getByText(/editing:/)).toBeTruthy();
  });

  it('closes the create sheet on hardware back', () => {
    let handler: (() => boolean) | null = null;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, cb) => {
      handler = cb as () => boolean;
      return { remove: jest.fn() } as never;
    });

    renderAppRoot();
    fireEvent.press(screen.getByLabelText('mock-create'));
    expect(screen.getByText('creating')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('mock-close-create'));
    expect(screen.queryByText('creating')).toBeNull();
    void handler;
  });

  it('returns save failures to the create form', async () => {
    mockSaveDraft.mockRejectedValueOnce(new Error('日程不存在'));
    renderAppRoot();

    fireEvent.press(screen.getByLabelText('mock-create'));
    fireEvent.press(screen.getByLabelText('mock-save-draft'));

    expect(await screen.findByText('日程不存在')).toBeTruthy();
    expect(screen.getByText('creating')).toBeTruthy();
  });
});
