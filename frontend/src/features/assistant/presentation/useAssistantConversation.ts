import { useEffect, useState } from 'react';

import type { AssistantApplicationPort } from '../application/AssistantApplication';
import type {
  AppliedCommand,
  ConversationTurnState,
  VoiceChatMessage,
} from '../domain/ConversationTurn';

/** 订阅编排服务的状态，展示层不用直接持有 AssistantConversationService。 */
export function useAssistantConversation(application: AssistantApplicationPort) {
  const [trackedApplication, setTrackedApplication] = useState(application);
  const [state, setState] = useState<ConversationTurnState>(() => application.getState());
  const [lastAppliedCommand, setLastAppliedCommand] = useState<AppliedCommand | null>(() =>
    application.getLastAppliedCommand(),
  );
  const [scheduleDataRevision, setScheduleDataRevision] = useState(
    () => application.getScheduleDataRevision?.() ?? 0,
  );
  const [replyText, setReplyText] = useState<string | null>(() => application.getReplyText());
  const [messages, setMessages] = useState<readonly VoiceChatMessage[]>(() =>
    application.getMessages(),
  );
  const [soundLevel, setSoundLevel] = useState<number | null>(() => application.getSoundLevel());

  // application 实例切换（如重新登录）时，渲染期间同步一次而不是在 effect 里
  // setState，避免多触发一轮 commit。
  if (trackedApplication !== application) {
    setTrackedApplication(application);
    setState(application.getState());
    setLastAppliedCommand(application.getLastAppliedCommand());
    setScheduleDataRevision(application.getScheduleDataRevision?.() ?? 0);
    setReplyText(application.getReplyText());
    setMessages(application.getMessages());
    setSoundLevel(application.getSoundLevel());
  }

  useEffect(() => {
    return application.subscribe((next) => {
      setState(next);
      setLastAppliedCommand(application.getLastAppliedCommand());
      setScheduleDataRevision(application.getScheduleDataRevision?.() ?? 0);
      setReplyText(application.getReplyText());
      setMessages(application.getMessages());
      setSoundLevel(application.getSoundLevel());
    });
  }, [application]);

  return {
    dismissReply: () => application.dismissReply(),
    endTurn: () => application.endTurn(),
    lastAppliedCommand,
    messages,
    replyText,
    scheduleDataRevision,
    soundLevel,
    startTurn: () => application.startTurn(),
    state,
    togglePause: () => application.togglePause?.(),
  };
}
