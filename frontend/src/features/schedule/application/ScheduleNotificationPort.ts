import type { ScheduleConflict } from '@/contracts';

/** UI-facing feedback supplied by the app composition root. */
export type ScheduleConflictNotifier = (conflicts: readonly ScheduleConflict[]) => void;
