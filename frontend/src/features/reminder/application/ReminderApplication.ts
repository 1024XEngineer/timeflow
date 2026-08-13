/**
 * 应用层对外名称。具体实现由组合根注入，后续替换适配器时无需修改展示层代码。
 */
export type {
  ReminderApplicationDependencies,
  ReminderApplicationPort,
  ReminderApplicationResult,
  ReminderSnoozeRequest,
} from './interfaces/ReminderApplicationPort';
export { LocalReminderApplication } from './LocalReminderApplication';
