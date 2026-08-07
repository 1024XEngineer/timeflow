import type {
  ReminderPresenterPort,
  ReminderPresentationAction,
  ReminderPresentationReceipt,
} from '../application/interfaces';
import type { ReminderDeliveryRequest } from '../domain';

/** 应用级弹窗/悬浮层完成前使用的固定展示器。 */
export class MockReminderPresenter implements ReminderPresenterPort {
  async show(_request: ReminderDeliveryRequest): Promise<ReminderPresentationReceipt> {
    return {
      presentation_id: 'mock-presentation-001',
      visible: true,
    };
  }

  async hide(_scheduleId: string): Promise<void> {
    return Promise.resolve();
  }

  onAction(
    _listener: (event: { schedule_id: string; action: ReminderPresentationAction }) => void,
  ): () => void {
    return () => undefined;
  }
}
