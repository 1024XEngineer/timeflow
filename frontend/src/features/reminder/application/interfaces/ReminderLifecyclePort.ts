import type { TelemetryAppState } from '../../../../shared/observability';

/** 提醒引擎订阅前后台，用来区分后台准时响铃和回前台才补上。 */
export interface ReminderLifecyclePort {
  current(): TelemetryAppState;
  subscribe(listener: (state: TelemetryAppState) => void): () => void;
}
