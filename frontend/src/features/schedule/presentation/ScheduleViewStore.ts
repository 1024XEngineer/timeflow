import type {
  GetSchedulesByDayQuery,
  ScheduleOccurrenceView,
} from '../application';

export interface ScheduleViewSnapshot {
  readonly accountId: string | null;
  readonly occurrences: readonly ScheduleOccurrenceView[];
  readonly selectedDate: string | null;
  readonly timezone: string | null;
}

const EMPTY_SNAPSHOT: ScheduleViewSnapshot = {
  accountId: null,
  occurrences: [],
  selectedDate: null,
  timezone: null,
};

/** 保存日程页面当前账号的内存投影；持久日程数据仍由本地仓储负责。 */
export class ScheduleViewStore {
  private snapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  getSnapshot(): ScheduleViewSnapshot {
    return this.snapshot;
  }

  replace(
    query: GetSchedulesByDayQuery,
    occurrences: readonly ScheduleOccurrenceView[],
  ): void {
    this.snapshot = {
      accountId: query.accountId,
      occurrences: [...occurrences],
      selectedDate: query.selectedDate,
      timezone: query.timezone,
    };
    this.emit();
  }

  clear(): void {
    if (this.snapshot === EMPTY_SNAPSHOT) {
      return;
    }
    this.snapshot = EMPTY_SNAPSHOT;
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
