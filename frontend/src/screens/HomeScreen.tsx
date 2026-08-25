import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { AssistantApplicationPort } from '../features/assistant/application/AssistantApplication';
import { AssistantVoiceOverlay } from '../features/assistant/presentation/AssistantVoiceOverlay';
import { useAssistantConversation } from '../features/assistant/presentation/useAssistantConversation';
import type {
  AlertDialogPort,
  DevicePermission,
  ReminderApplicationPort,
} from '../features/reminder';
import { useReminderPermissionNudge } from '../features/reminder';
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
  alertDialog: AlertDialogPort;
  isSigningOut: boolean;
  onSignOut: () => Promise<void>;
  /** 跳转权限列表页；不传具体权限就是打开列表让用户自己看，传了会定位/高亮那一行。 */
  onRequestPermission: (permission?: DevicePermission) => void;
  reminder: ReminderApplicationPort;
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
  alertDialog,
  isSigningOut,
  onSignOut,
  onRequestPermission,
  reminder,
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
  const [confirmRevision, setConfirmRevision] = useState(0);

  useReminderPermissionNudge(reminder, alertDialog, onRequestPermission);

  // 提醒确认（闹钟响铃/App 内弹窗）只写本地库，不经过语音写日程那条
  // scheduleDataRevision 路径——地点提醒确认后要从下方地点列表里消失，
  // 靠这里单独订阅触发重取，否则要等重启才会刷新。
  useEffect(
    () => reminder.onScheduleConfirmed(() => setConfirmRevision((value) => value + 1)),
    [reminder],
  );

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
        onOpenPermissions={() => onRequestPermission()}
        onSignOut={onSignOut}
        refreshSignal={pttScheduleRevision + callScheduleRevision + confirmRevision}
        focusTarget={focusTarget}
        service={scheduleService}
        timezone={timezone}
        username={username}
      />
      <AssistantVoiceOverlay
        alertDialog={alertDialog}
        continuousApplication={continuousApplication}
        onRequestPermission={onRequestPermission}
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
