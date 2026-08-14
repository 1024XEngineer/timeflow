import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import type { AssistantApplicationPort } from '../../../../../src/features/assistant/application/AssistantApplication';
import { AssistantVoiceOverlay } from '../../../../../src/features/assistant/presentation/AssistantVoiceOverlay';

jest.mock('../../../../../src/features/assistant/presentation/useAssistantConversation', () => ({
  useAssistantConversation: (application: AssistantApplicationPort) => ({
    dismissReply: mockDismissReply,
    endTurn: application.endTurn,
    lastAppliedCommand: null,
    replyText: application === mockPttApplication ? '已创建' : null,
    soundLevel: null,
    startTurn: application.startTurn,
    state: { phase: 'idle' as const },
    togglePause: () => {},
  }),
}));

let mockPttApplication: AssistantApplicationPort;
const mockDismissReply = jest.fn<AssistantApplicationPort['dismissReply']>();

function createApplication(): AssistantApplicationPort {
  return {
    dismissReply: async () => {},
    dispose: () => {},
    endTurn: async () => {},
    getLastAppliedCommand: () => null,
    getReplyText: () => null,
    getSoundLevel: () => null,
    getState: () => ({ phase: 'idle' }),
    startTurn: async () => {},
    subscribe: () => () => {},
  };
}

describe('AssistantVoiceOverlay layout', () => {
  it('does not add a fullscreen reply dismiss target over the calendar', () => {
    mockPttApplication = createApplication();
    const continuousApplication = createApplication();
    render(
      <AssistantVoiceOverlay
        continuousApplication={continuousApplication}
        pushToTalkApplication={mockPttApplication}
      />,
    );

    expect(screen.queryByLabelText('关闭回复')).toBeNull();
    expect(screen.getByText('按住说话')).toBeTruthy();
  });

  it('dismisses the reply when the bubble itself is pressed', () => {
    mockPttApplication = createApplication();
    const continuousApplication = createApplication();
    render(
      <AssistantVoiceOverlay
        continuousApplication={continuousApplication}
        pushToTalkApplication={mockPttApplication}
      />,
    );

    fireEvent.press(screen.getByText('已创建'));
    expect(mockDismissReply).toHaveBeenCalledTimes(1);
  });
});
