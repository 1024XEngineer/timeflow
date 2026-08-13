import { Alert } from 'react-native';

import type {
  ReminderPresentationAction,
  ReminderPresentationReceipt,
  ReminderPresenterPort,
} from '../application/interfaces';
import type { ReminderDeliveryRequest } from '../domain';

const MESSAGE_BY_REASON: Record<string, string> = {
  arrive_location: '您已进入目标地点附近，请及时处理。',
  return_to_recorded_location: '您已回到记录地点附近，请及时处理。',
  at_time: '已到提醒时间，请及时处理。',
  before_start: '日程即将开始，请及时处理。',
  snooze_expired: '延后提醒时间已到，请及时处理。',
  mock: '日程提醒已触发，请及时处理。',
};

/** 使用系统 Alert 的提醒展示适配器（无自定义 Dialog 依赖）。 */
export class AlertReminderPresenter implements ReminderPresenterPort {
  private readonly actionListeners = new Set<
    (event: { schedule_id: string; action: ReminderPresentationAction }) => void
  >();
  private visibleScheduleId: string | null = null;
  private readonly suppressed = new Set<string>();

  async show(request: ReminderDeliveryRequest): Promise<ReminderPresentationReceipt> {
    this.suppressed.delete(request.schedule_id);
    this.visibleScheduleId = request.schedule_id;
    const message = MESSAGE_BY_REASON[request.trigger.reason] ?? '日程提醒已触发，请及时处理。';

    Alert.alert(request.title || '日程提醒', message, [
      {
        text: '延后',
        style: 'cancel',
        onPress: () => this.emit(request.schedule_id, 'snooze'),
      },
      {
        text: '确认',
        onPress: () => this.emit(request.schedule_id, 'confirm'),
      },
    ]);

    return {
      presentation_id: `alert-${request.schedule_id}`,
      visible: true,
    };
  }

  async hide(scheduleId: string): Promise<void> {
    this.suppressed.add(scheduleId);
    if (this.visibleScheduleId === scheduleId) {
      this.visibleScheduleId = null;
    }
  }

  onAction(
    listener: (event: { schedule_id: string; action: ReminderPresentationAction }) => void,
  ): () => void {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
  }

  private emit(scheduleId: string, action: ReminderPresentationAction): void {
    if (this.suppressed.has(scheduleId)) return;
    for (const listener of this.actionListeners) {
      listener({ schedule_id: scheduleId, action });
    }
  }
}
