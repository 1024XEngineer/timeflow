import type {
  AppliedCommand,
  ConversationTurnState,
  VoiceChatMessage,
} from '../../domain/ConversationTurn';

export type AssistantApplicationDependencies = {
  transport: import('./VoiceTransportPort').VoiceTransportPort;
  capture: import('./AudioCapturePort').AudioCapturePort;
  playback: import('./AssistantAudioPlaybackPort').AssistantAudioPlaybackPort;
  /** 拿一次当前位置，随 session.hello 带上；拿不到就不带，不阻塞握手。 */
  location: import('../../../../infrastructure/location/LocationProvider').LocationProvider;
  /** voice.command.result 落地后写本地日历存储，供日历刷新读到。 */
  localScheduleWriter: import('./LocalScheduleWriterPort').LocalScheduleWriterPort;
  /** 前后台切换通知；连续模式用它触发切后台自动静音。 */
  appState: import('../../../../infrastructure/appState/AppStateProvider').AppStateProvider;
};

export interface AssistantApplicationOptions {
  accountId: string;
}

/**
 * 一次"按住说话"编排：建立连接（若未连接）→ 开录音流 → 松手结束流 → 等结果。
 * 展示层只调用这两个方法、订阅状态，不直接碰 WS 或录音 SDK。
 */
export interface AssistantApplicationPort {
  getState(): ConversationTurnState;
  subscribe(listener: (state: ConversationTurnState) => void): () => void;
  /** 最近一次成功应用的命令，供展示层显示"刚刚做了什么"。 */
  getLastAppliedCommand(): AppliedCommand | null;
  /** 本地日程数据每次成功写入后递增，供日历复用现有重读机制。 */
  getScheduleDataRevision?(): number;
  /** voice.dialogue.reply 的流式文字，给气泡展示；新一轮开始时清空。 */
  getReplyText(): string | null;
  /** 当前这一帧麦克风音量（dBFS），给录音中的波形展示；不在录音时是 null。 */
  getSoundLevel(): number | null;
  /** 免提长对话的用户/助手气泡；按住说话没有多轮记录，返回空数组。 */
  getMessages(): readonly VoiceChatMessage[];
  startTurn(): Promise<void>;
  endTurn(): Promise<void>;
  /** 用户主动关掉回复气泡：清空气泡内容并打断正在播放的 TTS。 */
  dismissReply(): Promise<void>;
  /** 连续模式独有：暂停/恢复麦克风推流，不挂断连接。按住说话不实现这个方法。 */
  togglePause?(): void;
  dispose(): void;
}
