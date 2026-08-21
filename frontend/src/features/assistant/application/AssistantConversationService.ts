import { isTransportError, type AssistantServerMessage } from '../../../contracts/conversation';
import type { ScheduleCategory } from '../../../contracts/schedule';
import type {
  AppliedCommand,
  ConversationTurnState,
  VoiceChatMessage,
} from '../domain/ConversationTurn';

import type {
  AssistantApplicationDependencies,
  AssistantApplicationOptions,
  AssistantApplicationPort,
} from './interfaces/AssistantApplicationPort';
import type { VoiceTransportConnection } from './interfaces/VoiceTransportPort';

const AUDIO_FORMAT = 'pcm_s16le';
const SAMPLE_RATE_HZ = 16000;
const CHANNELS = 1;
const EMPTY_MESSAGES: readonly VoiceChatMessage[] = [];
// 共享连接的握手超时（AuthenticatedWebSocketClient 内部固定 5s）已经不归这里管；
// 这个只是给定位单独留的预算，拿不到就不带，不能让 connect() 本身被定位拖住。
const LOCATION_TIMEOUT_MS = 2000;

/**
 * 一次"按住说话"编排的真实实现，按 AGENTS.md 第 6 节的时序把 transport / capture /
 * playback / location 四个端口串起来。展示层（useAssistantConversation）只订阅
 * 状态，不用理解握手、streamId、TTS 分片这些细节。
 */
export class AssistantConversationService implements AssistantApplicationPort {
  private connection: VoiceTransportConnection | null = null;
  private state: ConversationTurnState = { phase: 'idle' };
  private lastAppliedCommand: AppliedCommand | null = null;
  private scheduleDataRevision = 0;
  private readonly listeners = new Set<(state: ConversationTurnState) => void>();

  private conversationId: string | null = null;
  private streamId: string | null = null;
  /** 非 null 表示当前正处于 voice.tts.start 和 voice.tts.end 之间。 */
  private currentAudioId: string | null = null;
  private streamStartedWaiter: ((conversationId: string) => void) | null = null;
  /** 跟 streamStartedWaiter 配对；传输层报错/连接掉线时用它让等待方结束，不然会永远卡住。 */
  private streamStartRejecter: ((error: Error) => void) | null = null;
  /** connect() 里注册的三个监听器的统一取消订阅；dispose() 靠它把自己从共享连接上摘干净。 */
  private unsubscribeConnection: (() => void) | null = null;
  /** voice.dialogue.reply 的流式文字，展示层拿来当气泡内容；新一轮开始时清空。 */
  private replyText: string | null = null;
  /** 当前这一帧麦克风音量（dBFS），给波形展示；不在录音时是 null。 */
  private soundLevel: number | null = null;
  // 展示层的 onPressIn/onPressOut 不等待彼此:快速按放会让 endTurn() 在
  // streamId/conversationId 还没就绪时执行。endTurn() 等这个 promise，把两者
  // 重新串成先后顺序，而不是让 endTurn() 在它们仍是 null 时静默不做事。
  private pendingStartTurn: Promise<void> | null = null;
  /** Category events can arrive before the command result creates their local row. */
  private readonly pendingCategoryUpdates = new Map<string, ScheduleCategory>();
  /** 串起每条 voice.command.result 的本地落库，见 AssistantContinuousConversationService
   * 里同名字段的注释——一次按住说话也可能在一句话里触发多个工具调用（批量新建/
   * 删除），不排队会让两个 applyCommandResultLocally() 并发抢同一个 SQLite 连接。 */
  private commandResultChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly options: AssistantApplicationOptions,
    private readonly deps: AssistantApplicationDependencies,
  ) {}

  getState(): ConversationTurnState {
    return this.state;
  }

  subscribe(listener: (state: ConversationTurnState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getLastAppliedCommand(): AppliedCommand | null {
    return this.lastAppliedCommand;
  }

  getScheduleDataRevision(): number {
    return this.scheduleDataRevision;
  }

  getReplyText(): string | null {
    return this.replyText;
  }

  getMessages(): readonly VoiceChatMessage[] {
    return EMPTY_MESSAGES;
  }

  getSoundLevel(): number | null {
    return this.soundLevel;
  }

  async startTurn(): Promise<void> {
    const run = this._startTurn();
    this.pendingStartTurn = run;
    try {
      await run;
    } catch {
      // 失败时的状态（error/message）已经在触发失败的地方设过了
      // （handleMessage/handleClose，或者下面权限/采集失败的 catch）；这里
      // 只是让 pendingStartTurn 收敛，调用方（onPressIn）本来就不关心这个
      // promise 的结果，不需要再往外抛一次。
    } finally {
      if (this.pendingStartTurn === run) {
        this.pendingStartTurn = null;
      }
    }
  }

  private async _startTurn(): Promise<void> {
    this.replyText = null;
    this.soundLevel = null;
    if (this.connection === null) {
      this.setState({ phase: 'connecting' });
      await this.connect();
    }
    const connection = this.requireConnection();

    // 权限必须在 voice.stream.start 之前拿到并检查结果：这条消息一旦发出并被
    // 服务端确认，服务端就认为这个 session 有一条活跃的流；如果权限在那之后才
    // 被发现拒绝，我们没有办法清理（没收到 voice.stream.started 就没有
    // stream_id，发不了 voice.stream.end），这条 session 就再也开不了新流了。
    const permissionGranted = await this.deps.capture.requestPermission();
    if (!permissionGranted) {
      this.setState({ message: '没有麦克风权限', phase: 'error' });
      throw new Error('麦克风权限被拒绝');
    }

    const started = new Promise<string>((resolve, reject) => {
      this.streamStartedWaiter = resolve;
      this.streamStartRejecter = reject;
    });
    connection.send({
      payload: {
        audio_format: AUDIO_FORMAT,
        channels: CHANNELS,
        conversation_id: this.conversationId ?? undefined,
        sample_rate_hz: SAMPLE_RATE_HZ,
      },
      type: 'voice.stream.start',
    });
    const conversationId = await started;

    try {
      await this.deps.capture.start((chunk, soundLevel) => {
        connection.sendAudioFrame(chunk);
        this.soundLevel = soundLevel;
        this.notifyListeners();
      });
    } catch (error) {
      // 服务端这时候已经确认开流了（stream_id 拿到手了）；采集本身失败也要把
      // 这条流关掉，不然跟权限被拒是一样的后果——session 卡在"有一条活跃流"。
      if (this.streamId !== null) {
        connection.send({ payload: { stream_id: this.streamId }, type: 'voice.stream.end' });
        this.streamId = null;
      }
      this.setState({ message: '录音启动失败', phase: 'error' });
      throw error;
    }
    this.setState({ conversationId, phase: 'recording' });
  }

  async endTurn(): Promise<void> {
    if (this.pendingStartTurn !== null) {
      await this.pendingStartTurn.catch(() => undefined);
    }
    await this.deps.capture.stop();
    this.soundLevel = null;
    const connection = this.connection;
    if (connection !== null && this.streamId !== null) {
      connection.send({
        payload: { stream_id: this.streamId },
        type: 'voice.stream.end',
      });
      this.streamId = null;
    }
    if (this.conversationId !== null) {
      this.setState({ conversationId: this.conversationId, phase: 'awaiting_result' });
    }
  }

  async dismissReply(): Promise<void> {
    this.replyText = null;
    this.currentAudioId = null;
    this.notifyListeners();
    await this.deps.playback.stop().catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    this.pendingCategoryUpdates.clear();
    this.listeners.clear();
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = null;
    this.connection?.close();
    this.connection = null;
  }

  private async connect(): Promise<void> {
    // 拿不到定位（超时或权限拒绝）就不带，transport.connect() 收到 null 会跳过
    // session.hello 里的 latitude/longitude，不阻塞连接本身。定位那边先拿到就
    // 清掉超时定时器，不然赢了比赛的那次调用还会留一个挂到 2s 之后才触发的
    // 空转定时器（无功能影响，但测试环境里会被当成没清理干净的异步句柄）。
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const sample = await Promise.race([
      this.deps.location.getCurrentSample().catch(() => null),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), LOCATION_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timeoutId);

    // session.hello → session.ready 的握手已经在 transport.connect() 内部完成
    // （共享的 AuthenticatedWebSocketClient 负责），这里拿到的就是已经 ready 的连接。
    const connection = await this.deps.transport.connect(sample);
    this.connection = connection;
    const unsubscribeMessage = connection.onMessage((message) => this.handleMessage(message));
    const unsubscribeAudio = connection.onAudioFrame((chunk) => this.handleAudioFrame(chunk));
    const unsubscribeClose = connection.onClose((event) => this.handleClose(event));
    // 三个都要收，其中 onClose 转发到共享的 AuthenticatedWebSocketClient 上，
    // 不解绑就会在那条常驻连接上一直攒监听器（dispose()/换账号时尤其明显）。
    this.unsubscribeConnection = () => {
      unsubscribeMessage();
      unsubscribeAudio();
      unsubscribeClose();
    };
  }

  private handleMessage(message: AssistantServerMessage): void {
    if (isTransportError(message)) {
      this.setState({ message: message.error.message, phase: 'error' });
      this.rejectPendingStreamStart(new Error(message.error.message));
      return;
    }

    switch (message.type) {
      case 'voice.stream.started':
        this.streamId = message.payload.stream_id;
        this.conversationId = message.payload.conversation_id;
        this.streamStartedWaiter?.(message.payload.conversation_id);
        this.streamStartedWaiter = null;
        this.streamStartRejecter = null;
        return;
      case 'voice.command.result': {
        const command: AppliedCommand = {
          operation: message.payload.operation,
          schedule: message.payload.schedule,
          schedules: message.payload.schedules,
          occurrence_overrides: message.payload.occurrence_overrides,
          status: message.payload.status,
        };
        // 状态立刻回到 idle，不等写库；message.ack 必须等写库成功才发（AGENTS.md §6）。
        this.queueCommandResult(command, message.message_id);
        this.setState({ phase: 'idle' });
        return;
      }
      case 'schedule.category.updated':
        void this.applyCategoryUpdate(message.payload.schedule_id, message.payload.category);
        return;
      case 'voice.dialogue.question':
        this.setState({
          conversationId: message.conversation_id,
          phase: 'asking',
          speechText: message.payload.speech_text,
        });
        return;
      case 'voice.dialogue.reply':
        this.replyText = message.payload.speech_text;
        this.notifyListeners();
        return;
      case 'voice.tts.start':
        this.currentAudioId = message.audio_id;
        this.setState({ conversationId: message.conversation_id, phase: 'speaking' });
        this.deps.playback
          .startStream({
            encoding: 'pcm_s16le',
            sampleRateHz: message.payload.sample_rate_hz,
          })
          .catch(() => {});
        return;
      case 'voice.tts.end':
        this.currentAudioId = null;
        this.deps.playback.endStream().catch(() => {});
        this.setState({ phase: 'idle' });
        return;
      default:
        return;
    }
  }

  /** .catch(() => {}) 必须紧跟在同一条语句里同步接上——迟一拍再接（比如靠下一次
   * queueCommandResult 调用里的第二个 then 参数兜底）这段窗口期这个被拒绝的
   * promise 没有任何 handler，Node 的 unhandled rejection 检测在下一次调用到达前
   * 就已经判定"没人接"，直接把整个进程带崩——不是理论风险，用一个会抛的 state
   * 订阅者复现过。 */
  private queueCommandResult(command: AppliedCommand, messageId: string): void {
    this.commandResultChain = this.commandResultChain
      .then(() => this.applyCommandResultLocally(command, messageId))
      .catch(() => {});
  }

  private async applyCommandResultLocally(
    command: AppliedCommand,
    messageId: string,
  ): Promise<void> {
    if (this.disposed) return;
    try {
      await this.deps.localScheduleWriter.applyCommandResult(this.options.accountId, command);
    } catch {
      // 写失败不重试；不发 ack，避免向服务端谎报已落库。
      return;
    }
    this.lastAppliedCommand = command;
    this.markScheduleDataChanged();
    this.connection?.send({ message_id: messageId, status: 'applied', type: 'message.ack' });
    const schedules = command.schedules ?? (command.schedule ? [command.schedule] : []);
    await this.applyPendingCategoryUpdates(
      schedules.flatMap((schedule) => (typeof schedule.id === 'string' ? [schedule.id] : [])),
    );
  }

  private async applyCategoryUpdate(scheduleId: string, category: ScheduleCategory): Promise<void> {
    if (this.disposed) return;
    const key = this.categoryKey(scheduleId);
    this.pendingCategoryUpdates.set(key, category);
    try {
      const applied = await this.deps.localScheduleWriter.applyCategoryUpdate?.(
        this.options.accountId,
        scheduleId,
        category,
      );
      if (this.disposed) return;
      if (applied === true && this.pendingCategoryUpdates.get(key) === category) {
        this.pendingCategoryUpdates.delete(key);
        this.markScheduleDataChanged();
      }
    } catch {
      if (!this.disposed) this.pendingCategoryUpdates.set(key, category);
    }
  }

  private async applyPendingCategoryUpdates(scheduleIds: readonly string[]): Promise<void> {
    for (const scheduleId of scheduleIds) {
      const key = this.categoryKey(scheduleId);
      const category = this.pendingCategoryUpdates.get(key);
      if (category === undefined || this.disposed) continue;
      try {
        const applied = await this.deps.localScheduleWriter.applyCategoryUpdate?.(
          this.options.accountId,
          scheduleId,
          category,
        );
        if (this.disposed) return;
        if (applied === true) {
          this.pendingCategoryUpdates.delete(key);
          this.markScheduleDataChanged();
        }
      } catch {
        // Keep the latest pending value for a later authoritative local write.
      }
    }
  }

  private categoryKey(scheduleId: string): string {
    return `${this.options.accountId}\u0000${scheduleId}`;
  }

  private markScheduleDataChanged(): void {
    this.scheduleDataRevision += 1;
    this.notifyListeners();
  }

  private handleAudioFrame(chunk: ArrayBuffer): void {
    if (this.currentAudioId === null) {
      return;
    }
    this.deps.playback.pushChunk(chunk).catch(() => {});
  }

  private handleClose(event: { code: number; reason: string }): void {
    // 必须真的执行：切到连续对话时共享 WS 会因 voiceMode 不同断开重连，只置空的话
    // 旧服务仍订阅着新连接的 TTS/PCM，同一句话会被两个服务重复送进播放器。
    this.unsubscribeConnection?.();
    this.connection = null;
    this.unsubscribeConnection = null;
    const message = event.reason || `连接已断开（${event.code}）`;
    this.setState({ message, phase: 'error' });
    this.rejectPendingStreamStart(new Error(message));
  }

  /** 传输层报错或连接掉线时用它结束还在等 voice.stream.started 的 promise，不然会永远卡住。 */
  private rejectPendingStreamStart(error: Error): void {
    const reject = this.streamStartRejecter;
    this.streamStartedWaiter = null;
    this.streamStartRejecter = null;
    reject?.(error);
  }

  private requireConnection(): VoiceTransportConnection {
    if (this.connection === null) {
      throw new Error('startTurn called without an open connection');
    }
    return this.connection;
  }

  private setState(state: ConversationTurnState): void {
    this.state = state;
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
