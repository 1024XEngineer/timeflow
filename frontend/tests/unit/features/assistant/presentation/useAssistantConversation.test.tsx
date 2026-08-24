import { describe, expect, it } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type { AssistantApplicationPort } from '../../../../../src/features/assistant/application/AssistantApplication';
import type {
  ConversationTurnState,
  VoiceChatMessage,
} from '../../../../../src/features/assistant/domain/ConversationTurn';
import { useAssistantConversation } from '../../../../../src/features/assistant/presentation/useAssistantConversation';

function createApplication(initialMessages: readonly VoiceChatMessage[]) {
  let messages = initialMessages;
  const listeners = new Set<(state: ConversationTurnState) => void>();
  const application: AssistantApplicationPort = {
    dismissReply: async () => {},
    dispose: () => {},
    endTurn: async () => {},
    getLastAppliedCommand: () => null,
    getMessages: () => messages,
    getReplyText: () => null,
    getSoundLevel: () => null,
    getState: () => ({ phase: 'idle' }),
    startTurn: async () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    application,
    setMessages(nextMessages: readonly VoiceChatMessage[]) {
      messages = nextMessages;
      for (const listener of listeners) listener({ phase: 'listening', conversationId: 'c1' });
    },
  };
}

describe('useAssistantConversation', () => {
  it('keeps bubble history in sync after updates and application replacement', () => {
    const first = createApplication([{ id: 'u1', role: 'user', text: '第一句' }]);
    const { result, rerender } = renderHook(useAssistantConversation, {
      initialProps: first.application,
    });

    expect(result.current.messages).toEqual([{ id: 'u1', role: 'user', text: '第一句' }]);

    act(() =>
      first.setMessages([
        { id: 'u1', role: 'user', text: '第一句' },
        { id: 'a1', role: 'assistant', text: '第一句回复' },
      ]),
    );
    expect(result.current.messages).toEqual([
      { id: 'u1', role: 'user', text: '第一句' },
      { id: 'a1', role: 'assistant', text: '第一句回复' },
    ]);

    const second = createApplication([{ id: 'u2', role: 'user', text: '第二句' }]);
    rerender(second.application);

    expect(result.current.messages).toEqual([{ id: 'u2', role: 'user', text: '第二句' }]);
  });
});
