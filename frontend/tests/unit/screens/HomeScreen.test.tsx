import { act, render, waitFor } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';

import type { AssistantApplicationPort } from '../../../src/features/assistant/application/AssistantApplication';
import type {
  AppliedCommand,
  ConversationTurnState,
} from '../../../src/features/assistant/domain/ConversationTurn';
import type { ScheduleCalendarReadService } from '../../../src/features/schedule/application';
import { HomeScreen } from '../../../src/screens/HomeScreen';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

jest.mock('../../../src/features/assistant/presentation/AssistantVoiceOverlay', () => ({
  AssistantVoiceOverlay: () => null,
}));

class FakeAssistantApplication implements AssistantApplicationPort {
  private command: AppliedCommand | null = null;
  private scheduleDataRevision = 0;
  private readonly listeners = new Set<(state: ConversationTurnState) => void>();

  apply(command: AppliedCommand) {
    this.command = command;
    this.scheduleDataRevision += 1;
    for (const listener of this.listeners) listener({ phase: 'idle' });
  }

  applyCategoryUpdate() {
    this.scheduleDataRevision += 1;
    for (const listener of this.listeners) listener({ phase: 'idle' });
  }

  dismissReply = async () => {};
  dispose = () => {};
  endTurn = async () => {};
  getLastAppliedCommand = () => this.command;
  getScheduleDataRevision = () => this.scheduleDataRevision;
  getReplyText = () => null;
  getMessages = () => [];
  getSoundLevel = () => null;
  getState = (): ConversationTurnState => ({ phase: 'idle' });
  startTurn = async () => {};
  subscribe = (listener: (state: ConversationTurnState) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

describe('HomeScreen calendar refresh', () => {
  it('reloads account-scoped calendar data after a voice command is applied', async () => {
    const pushToTalkApplication = new FakeAssistantApplication();
    const continuousApplication = new FakeAssistantApplication();
    const scheduleService: ScheduleCalendarReadService = {
      getLocationSchedules: jest
        .fn<ScheduleCalendarReadService['getLocationSchedules']>()
        .mockResolvedValue([]),
      getSchedulesByDay: jest
        .fn<ScheduleCalendarReadService['getSchedulesByDay']>()
        .mockResolvedValue([]),
      getSchedulesByRange: jest
        .fn<ScheduleCalendarReadService['getSchedulesByRange']>()
        .mockResolvedValue([]),
    };
    render(
      <HomeScreen
        accountId="account-a"
        continuousApplication={continuousApplication}
        alertDialog={{ show: async () => {} }}
        isSigningOut={false}
        onRequestPermission={() => {}}
        onSignOut={async () => {}}
        pushToTalkApplication={pushToTalkApplication}
        reminder={{ onPermissionBlocked: () => () => {} } as never}
        scheduleService={scheduleService}
        timezone="Asia/Shanghai"
        username="Sarah"
      />,
    );

    await waitFor(() => expect(scheduleService.getSchedulesByRange).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(scheduleService.getLocationSchedules).toHaveBeenCalledTimes(1));

    act(() => {
      pushToTalkApplication.apply({ operation: 'update_schedule', status: 'applied' });
    });

    await waitFor(() => expect(scheduleService.getSchedulesByRange).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(scheduleService.getLocationSchedules).toHaveBeenCalledTimes(2));

    act(() => {
      continuousApplication.apply({ operation: 'create_schedule', status: 'applied' });
    });

    await waitFor(() => expect(scheduleService.getSchedulesByRange).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(scheduleService.getLocationSchedules).toHaveBeenCalledTimes(3));

    act(() => {
      pushToTalkApplication.applyCategoryUpdate();
    });

    await waitFor(() => expect(scheduleService.getSchedulesByRange).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(scheduleService.getLocationSchedules).toHaveBeenCalledTimes(4));
    expect(scheduleService.getSchedulesByRange).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountId: 'account-a' }),
    );
    expect(scheduleService.getLocationSchedules).toHaveBeenLastCalledWith({
      accountId: 'account-a',
    });
  });
});
