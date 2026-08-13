import type { AppliedCommand } from '../../domain/ConversationTurn';

/**
 * 把 voice.command.result 落地的日程写进本地存储，供日历读服务立刻看见。
 * `assistant` 这边只依赖这个端口，不直接碰 `schedule` 域的仓储——具体怎么写
 * （SQLite、还是别的）由组合根注入的实现决定。
 */
export interface LocalScheduleWriterPort {
  applyCommandResult(accountId: string, command: AppliedCommand): Promise<void>;
}
