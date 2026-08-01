export type AssistantRole = 'user' | 'assistant';

export type AssistantMessageAction = {
  id: string;
  label: string;
  kind: 'confirm' | 'dismiss';
};

/** 助手解析出的草稿状态：待确认 / 已加入日程 / 已忽略。 */
export type AssistantDraftState = 'pending' | 'added' | 'dismissed';

/** 语音被解析成的日程草稿，用卡片展示而不是塞进对话文字里。 */
export type AssistantDraft = {
  title: string;
  whenLabel: string;
  metaLabel?: string;
  /** 解析字段不完整时只展示草稿，不允许直接写入日程。 */
  clarificationLabel?: string;
  state?: AssistantDraftState;
};

export type AssistantMessage = {
  id: string;
  role: AssistantRole;
  createdAt: number;
  /** 纯文本内容；带 draft 的助手消息可以只给卡片。 */
  text?: string;
  draft?: AssistantDraft;
  /** 助手消息可附带确认操作；点过后清空。 */
  actions?: AssistantMessageAction[];
};
