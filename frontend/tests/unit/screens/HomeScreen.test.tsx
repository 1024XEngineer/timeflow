import { act, render, waitFor } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';

import type { AssistantApplicationPort } from '../../../src/features/assistant/application/AssistantApplication';
import type {
  AppliedCommand,
  ConversationTurnState,
} from '../../../src/features/assistant/domain/ConversationTurn';
import type { ScheduleCalendarReadService } from '../../../src/features/schedule/application';
import { HomeScreen } from '../../../src/screens/HomeScreen';

jest.mock('../../../src/features/assistant/presentation/AssistantVoiceOverlay', () => ({
  AssistantVoiceOverlay: () => null,
}));

class FakeAssistantApplication implements AssistantApplicationPort {
  private command: AppliedCommand | null = null;
  private readonly listeners = new Set<(state: ConversationTurnState) => void>();

  apply(command: AppliedCommand) {
    this.command = command;
    for (const listener of this.listeners) listener({ phase: 'idle' });
  }

  dismissReply = async () => {};
  dispose = () => {};
  endTurn = async () => {};
  getLastAppliedCommand = () => this.command;
  getReplyText = () => null;
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
        isSigningOut={false}
        onSignOut={async () => {}}
        pushToTalkApplication={pushToTalkApplication}
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
    expect(scheduleService.getSchedulesByRange).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountId: 'account-a' }),
    );
    expect(scheduleService.getLocationSchedules).toHaveBeenLastCalledWith({
      accountId: 'account-a',
    });
  });
});
