import type { AssistantApplicationPort } from '../application/AssistantApplication';
import type { AppliedCommand, ConversationTurnState } from '../domain/ConversationTurn';

const PREVIEW_VOICE_UNAVAILABLE = '预览模式不包含语音助手';

/** 预览用语音编排：界面仍能看见入口，真正开麦时给出明确说明。 */
export class MockAssistantApplication implements AssistantApplicationPort {
  private readonly listeners = new Set<(state: ConversationTurnState) => void>();
  private state: ConversationTurnState = { phase: 'idle' };

  getState(): ConversationTurnState {
    return this.state;
  }

  subscribe(listener: (state: ConversationTurnState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getLastAppliedCommand(): AppliedCommand | null {
    return null;
  }

  getReplyText(): string | null {
    return null;
  }

  getSoundLevel(): number | null {
    return null;
  }

  async startTurn(): Promise<void> {
    this.publish({ phase: 'error', message: PREVIEW_VOICE_UNAVAILABLE });
  }

  async endTurn(): Promise<void> {
    this.publish({ phase: 'idle' });
  }

  async dismissReply(): Promise<void> {
    this.publish({ phase: 'idle' });
  }

  togglePause(): void {
    this.publish({ phase: 'idle' });
  }

  dispose(): void {
    this.listeners.clear();
    this.state = { phase: 'idle' };
  }

  private publish(state: ConversationTurnState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
