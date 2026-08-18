import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { AssistantApplicationPort } from '../../../../../src/features/assistant/application/AssistantApplication';
import type { ConversationTurnState } from '../../../../../src/features/assistant/domain/ConversationTurn';
import { AssistantVoiceOverlay } from '../../../../../src/features/assistant/presentation/AssistantVoiceOverlay';

jest.mock('../../../../../src/features/assistant/presentation/useAssistantConversation', () => ({
  useAssistantConversation: (application: AssistantApplicationPort) => ({
    dismissReply: mockDismissReply,
    endTurn: application.endTurn,
    lastAppliedCommand: null,
    replyText: application === mockPttApplication ? '已创建' : null,
    soundLevel: null,
    startTurn: application.startTurn,
    state: application === mockPttApplication ? { phase: 'idle' as const } : mockCallState,
    togglePause: () => {},
    turns: [],
  }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: mockBottomInset, left: 0, right: 0, top: 0 }),
}));

let mockPttApplication: AssistantApplicationPort;
let mockBottomInset = 0;
let mockCallState: ConversationTurnState = { phase: 'idle' };
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
  beforeEach(() => {
    mockBottomInset = 0;
    mockCallState = { phase: 'idle' };
    mockDismissReply.mockClear();
  });

  afterEach(() => {
    mockCallState = { phase: 'idle' };
  });

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

  it.each([
    ['keeps a comfortable offset on devices with a small inset', 8, 32],
    ['moves controls above the system navigation area', 34, 50],
  ])('%s', (_name, bottomInset, expectedBottom) => {
    mockBottomInset = bottomInset;
    mockPttApplication = createApplication();
    const continuousApplication = createApplication();
    render(
      <AssistantVoiceOverlay
        continuousApplication={continuousApplication}
        pushToTalkApplication={mockPttApplication}
      />,
    );

    expect(
      StyleSheet.flatten(screen.getByTestId('assistant-voice-controls').props.style),
    ).toMatchObject({
      bottom: expectedBottom,
    });
  });

  it('shows only a generic status label while replying, never the reply content', () => {
    mockPttApplication = createApplication();
    const continuousApplication = createApplication();
    mockCallState = { conversationId: 'c1', phase: 'speaking' };
    render(
      <AssistantVoiceOverlay
        continuousApplication={continuousApplication}
        pushToTalkApplication={mockPttApplication}
      />,
    );

    fireEvent.press(screen.getByLabelText('进入免提通话'));

    expect(screen.getByText('回答中…')).toBeTruthy();
  });

  it('shows a generic "已打断" label when the reply is interrupted', () => {
    mockPttApplication = createApplication();
    const continuousApplication = createApplication();
    mockCallState = { conversationId: 'c1', phase: 'interrupted' };
    render(
      <AssistantVoiceOverlay
        continuousApplication={continuousApplication}
        pushToTalkApplication={mockPttApplication}
      />,
    );

    fireEvent.press(screen.getByLabelText('进入免提通话'));

    expect(screen.getByText('已打断')).toBeTruthy();
  });

  it('shows a generic paused label instead of reply content', () => {
    mockPttApplication = createApplication();
    const continuousApplication = createApplication();
    mockCallState = { conversationId: 'c1', phase: 'paused' };
    render(
      <AssistantVoiceOverlay
        continuousApplication={continuousApplication}
        pushToTalkApplication={mockPttApplication}
      />,
    );

    fireEvent.press(screen.getByLabelText('进入免提通话'));

    expect(screen.getByText('已暂停，点一下继续')).toBeTruthy();
  });
});
