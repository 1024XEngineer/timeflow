import { describe, expect, it } from '@jest/globals';

import { MockAssistantApplication } from '../../../../../src/features/assistant/data/MockAssistantApplication';

describe('MockAssistantApplication', () => {
  it('explains that voice is unavailable instead of opening a socket', async () => {
    const application = new MockAssistantApplication();
    const seen: string[] = [];
    const unsubscribe = application.subscribe((state) => seen.push(state.phase));

    await application.startTurn();
    expect(application.getState()).toEqual({
      message: '预览模式不包含语音助手',
      phase: 'error',
    });
    expect(seen).toEqual(['error']);

    await application.endTurn();
    expect(application.getState()).toEqual({ phase: 'idle' });
    unsubscribe();
    application.dispose();
  });
});
