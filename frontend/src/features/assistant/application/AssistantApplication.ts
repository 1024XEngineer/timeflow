/**
 * 应用层对外名称。具体实现（AssistantConversationService）由组合根注入，
 * 展示层只依赖这里导出的接口。
 */
export type {
  AssistantApplicationDependencies,
  AssistantApplicationOptions,
  AssistantApplicationPort,
} from './interfaces/AssistantApplicationPort';
