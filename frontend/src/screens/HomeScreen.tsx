import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { AssistantApplicationPort } from '../features/assistant/application/AssistantApplication';
import { AssistantVoiceOverlay } from '../features/assistant/presentation/AssistantVoiceOverlay';
import { useAssistantConversation } from '../features/assistant/presentation/useAssistantConversation';
import type { ScheduleCalendarReadService } from '../features/schedule/application';
import { ScheduleCalendarScreen } from '../features/schedule/presentation/ScheduleCalendarScreen';
import {
  calendarFocusTargetFromCommand,
  type CalendarFocusTarget,
} from '../features/schedule/presentation/calendarFocus';

interface HomeScreenProps {
  pushToTalkApplication: AssistantApplicationPort;
  continuousApplication: AssistantApplicationPort;
  scheduleService: ScheduleCalendarReadService;
  accountId: string;
  isSigningOut: boolean;
  onSignOut: () => Promise<void>;
  timezone: string;
  username: string;
}

/**
 * 登录后的主屏：日历 + 语音入口。按住说话和免提通话是两个各自独立连接的
 * AssistantApplicationPort 实例，任一个写完本地库都要触发日历重取，所以这里
 * 分别订阅两边的 lastAppliedCommand。
 */
export function HomeScreen({
  pushToTalkApplication,
  continuousApplication,
  scheduleService,
  accountId,
  isSigningOut,
  onSignOut,
  timezone,
  username,
}: HomeScreenProps) {
  const { lastAppliedCommand: pttCommand } = useAssistantConversation(pushToTalkApplication);
  const { lastAppliedCommand: callCommand } = useAssistantConversation(continuousApplication);
  const [trackedPttCommand, setTrackedPttCommand] = useState(pttCommand);
  const [trackedCallCommand, setTrackedCallCommand] = useState(callCommand);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [focusTarget, setFocusTarget] = useState<CalendarFocusTarget | null>(null);

  // command.result 写完本地库之后 lastAppliedCommand 才会更新（见
  // AssistantConversationService.applyCommandResultLocally），所以这里发现它
  // 变化时数据已经落地了，直接触发日历重取。渲染期间同步而不是在 effect 里
  // setState，避免多触发一轮 commit（跟 useAssistantConversation 里同一个原因）。
  if (trackedPttCommand !== pttCommand) {
    setTrackedPttCommand(pttCommand);
    if (pttCommand !== null) {
      setFocusTarget(calendarFocusTargetFromCommand(pttCommand));
      setRefreshSignal((value) => value + 1);
    }
  }
  if (trackedCallCommand !== callCommand) {
    setTrackedCallCommand(callCommand);
    if (callCommand !== null) {
      setFocusTarget(calendarFocusTargetFromCommand(callCommand));
      setRefreshSignal((value) => value + 1);
    }
  }

  return (
    <View style={styles.screen}>
      <ScheduleCalendarScreen
        accountId={accountId}
        isSigningOut={isSigningOut}
        onSignOut={onSignOut}
        refreshSignal={refreshSignal}
        focusTarget={focusTarget}
        service={scheduleService}
        timezone={timezone}
        username={username}
      />
      <AssistantVoiceOverlay
        continuousApplication={continuousApplication}
        pushToTalkApplication={pushToTalkApplication}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
});
