import { ScheduleLocalRepository } from '../../../schedule/data';
import { openTimeflowDatabase } from '../../../../infrastructure/database';
import type { LocalScheduleReader } from '../../application/interfaces';
import { InMemoryLocalScheduleReader } from './InMemoryLocalScheduleReader';
import { toLocalReminderSchedule } from './toLocalReminderSchedule';

export function isHydratableScheduleReader(
  reader: LocalScheduleReader,
): reader is InMemoryLocalScheduleReader {
  return reader instanceof InMemoryLocalScheduleReader;
}

/** 用当前账号的 SQLite `local_schedules` 填满进程内投影，供 LocalReminderApplication rebuild。 */
export async function hydrateInMemorySchedulesFromLocalDb(
  reader: InMemoryLocalScheduleReader,
  accountId: string,
): Promise<number> {
  try {
    const database = await openTimeflowDatabase();
    const repository = new ScheduleLocalRepository(database);
    const rows = await repository.listSchedules(accountId);
    const schedules = rows.filter((row) => row.status === 'active').map(toLocalReminderSchedule);
    reader.replaceAll(schedules);
    return schedules.length;
  } catch {
    reader.replaceAll([]);
    return 0;
  }
}
