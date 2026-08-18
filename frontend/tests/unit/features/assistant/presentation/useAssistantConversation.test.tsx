import { describe, expect, it } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type { AssistantApplicationPort } from '../../../../../src/features/assistant/application/AssistantApplication';
import type {
  ConversationTurnRecord,
  ConversationTurnState,
} from '../../../../../src/features/assistant/domain/ConversationTurn';
import { useAssistantConversation } from '../../../../../src/features/assistant/presentation/useAssistantConversation';

function createApplication(initialTurns: readonly ConversationTurnRecord[]) {
  let turns = initialTurns;
  const listeners = new Set<(state: ConversationTurnState) => void>();
  const application: AssistantApplicationPort = {
    dismissReply: async () => {},
    dispose: () => {},
    endTurn: async () => {},
    getLastAppliedCommand: () => null,
    getReplyText: () => null,
    getSoundLevel: () => null,
    getState: () => ({ phase: 'idle' }),
    getTurns: () => turns,
    startTurn: async () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    application,
    setTurns(nextTurns: readonly ConversationTurnRecord[]) {
      turns = nextTurns;
      for (const listener of listeners) listener({ phase: 'listening', conversationId: 'c1' });
    },
  };
}

describe('useAssistantConversation', () => {
  it('keeps turn history in sync after updates and application replacement', () => {
    const first = createApplication([{ id: 't1', replyText: null, transcript: '第一句' }]);
    const { result, rerender } = renderHook(useAssistantConversation, {
      initialProps: first.application,
    });

    expect(result.current.turns).toEqual([{ id: 't1', replyText: null, transcript: '第一句' }]);

    act(() => first.setTurns([{ id: 't1', replyText: '第一句回复', transcript: '第一句' }]));
    expect(result.current.turns).toEqual([
      { id: 't1', replyText: '第一句回复', transcript: '第一句' },
    ]);

    const second = createApplication([{ id: 't2', replyText: null, transcript: '第二句' }]);
    rerender(second.application);

    expect(result.current.turns).toEqual([{ id: 't2', replyText: null, transcript: '第二句' }]);
  });
});
