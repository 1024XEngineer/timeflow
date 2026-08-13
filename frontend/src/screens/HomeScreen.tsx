import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { AssistantApplicationPort } from '../features/assistant/application/AssistantApplication';
import { AssistantVoiceOverlay } from '../features/assistant/presentation/AssistantVoiceOverlay';
import { useAssistantConversation } from '../features/assistant/presentation/useAssistantConversation';
import type { ScheduleCalendarReadService } from '../features/schedule/application';
import { ScheduleCalendarScreen } from '../features/schedule/presentation/ScheduleCalendarScreen';

interface HomeScreenProps {
  application: AssistantApplicationPort;
  scheduleService: ScheduleCalendarReadService;
  accountId: string;
  timezone: string;
}

/** 登录后的主屏：日历 + 语音入口，共用同一个 AssistantConversationService 实例。 */
export function HomeScreen({ application, scheduleService, accountId, timezone }: HomeScreenProps) {
  const { lastAppliedCommand } = useAssistantConversation(application);
  const [trackedCommand, setTrackedCommand] = useState(lastAppliedCommand);
  const [refreshSignal, setRefreshSignal] = useState(0);

  // command.result 写完本地库之后 lastAppliedCommand 才会更新（见
  // AssistantConversationService.applyCommandResultLocally），所以这里发现它
  // 变化时数据已经落地了，直接触发日历重取。渲染期间同步而不是在 effect 里
  // setState，避免多触发一轮 commit（跟 useAssistantConversation 里同一个原因）。
  if (trackedCommand !== lastAppliedCommand) {
    setTrackedCommand(lastAppliedCommand);
    if (lastAppliedCommand !== null) {
      setRefreshSignal((value) => value + 1);
    }
  }

  return (
    <View style={styles.screen}>
      <ScheduleCalendarScreen
        accountId={accountId}
        refreshSignal={refreshSignal}
        service={scheduleService}
        timezone={timezone}
      />
      <AssistantVoiceOverlay application={application} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
});
