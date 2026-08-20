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
 * 分别订阅两边的日程数据 revision。
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
  const { lastAppliedCommand: pttCommand, scheduleDataRevision: pttScheduleRevision } =
    useAssistantConversation(pushToTalkApplication);
  const { lastAppliedCommand: callCommand, scheduleDataRevision: callScheduleRevision } =
    useAssistantConversation(continuousApplication);
  const [trackedPttCommand, setTrackedPttCommand] = useState(pttCommand);
  const [trackedCallCommand, setTrackedCallCommand] = useState(callCommand);
  const [focusTarget, setFocusTarget] = useState<CalendarFocusTarget | null>(null);

  // command.result 写完本地库之后 lastAppliedCommand 才会更新（见
  // AssistantConversationService.applyCommandResultLocally），所以这里发现它
  // 变化时数据已经落地了，可以安全更新聚焦目标。日历重取由下方 revision 驱动，
  // category patch 也会递增它。渲染期间同步以避免多触发一轮 commit。
  if (trackedPttCommand !== pttCommand) {
    setTrackedPttCommand(pttCommand);
    if (pttCommand !== null) {
      setFocusTarget(calendarFocusTargetFromCommand(pttCommand));
    }
  }
  if (trackedCallCommand !== callCommand) {
    setTrackedCallCommand(callCommand);
    if (callCommand !== null) {
      setFocusTarget(calendarFocusTargetFromCommand(callCommand));
    }
  }

  return (
    <View style={styles.screen}>
      <ScheduleCalendarScreen
        accountId={accountId}
        isSigningOut={isSigningOut}
        onSignOut={onSignOut}
        refreshSignal={pttScheduleRevision + callScheduleRevision}
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
