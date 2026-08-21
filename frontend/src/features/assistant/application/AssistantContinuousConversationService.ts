import { isTransportError, type AssistantServerMessage } from '../../../contracts/conversation';
import type { ScheduleCategory } from '../../../contracts/schedule';
import type { AppLifecycleStatus } from '../../../infrastructure/appState/AppStateProvider';
import type {
  AppliedCommand,
  ConversationTurnRecord,
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
// 共享连接的握手超时（AuthenticatedWebSocketClient 内部固定 5s）已经不归这里管；
// 这个只是给定位单独留的预算，拿不到就不带，不能让 connect() 本身被定位拖住。
const LOCATION_TIMEOUT_MS = 2000;
// 整场空闲超时：会话建立、听到一句真实语音、或播完一次回复之后，这个窗口内
// 完全没有下一次真实语音就自动挂断。三分钟落在产品要求的 1~5 分钟区间中段；
// 单独的"等待用户输入 10~30 秒"档位按设计简化，不再单独实现——这一档就是
// 最终会触发动作的那一档。
const SESSION_IDLE_TIMEOUT_MS = 180_000;

/** 允许暂停/由暂停恢复的阶段——除此之外调用 togglePause() 什么都不做。 */
const PAUSABLE_PHASES: ReadonlySet<ConversationTurnState['phase']> = new Set([
  'listening',
  'speaking',
  'asking',
  'interrupted',
]);

/**
 * 免提连续对话编排：一次 startTurn() 打开麦克风、发一次 voice.stream.start，
 * 之后持续推流直到 endTurn() 主动关闭。一次开麦期间服务端可能触发多轮
 * transcript/回复（由 vendor 的 turn_detection 决定边界），所以这里完成一轮
 * 后回到 'listening' 而不是 'idle'，且新增了处理 voice.tts.canceled（被打断）
 * 的分支。
 *
 * 与 AssistantConversationService（按住说话）刻意保持两个独立的类，不共享
 * connect() 实现：这批端口本身够通用，但两条编排路径的状态机形状不同，合并
 * 会让按住说话那条已经在用的路径承担连续模式的改动风险。两者共用同一个
 * AuthenticatedWebSocketClient（各自持有绑定了不同 voiceMode 的
 * AuthenticatedVoiceTransport 实例），但从不同时连接——UI 层互斥两条路径。
 */
export class AssistantContinuousConversationService implements AssistantApplicationPort {
  private connection: VoiceTransportConnection | null = null;
  private state: ConversationTurnState = { phase: 'idle' };
  private lastAppliedCommand: AppliedCommand | null = null;
  private scheduleDataRevision = 0;
  private readonly listeners = new Set<(state: ConversationTurnState) => void>();

  private conversationId: string | null = null;
  private streamId: string | null = null;
  /** 非 null 表示当前正处于 voice.tts.start 和 voice.tts.end/canceled 之间。 */
  private currentAudioId: string | null = null;
  /** 最近被打断的音频 id；服务端会在 canceled 后补发同 id 的 tts.end。 */
  private canceledAudioId: string | null = null;
  private streamStartedWaiter: ((conversationId: string) => void) | null = null;
  /** 跟 streamStartedWaiter 配对；传输层报错/连接掉线时用它让等待方结束，不然会永远卡住。 */
  private streamStartRejecter: ((error: Error) => void) | null = null;
  /** connect() 里注册的三个监听器的统一取消订阅；dispose() 靠它把自己从共享连接上摘干净。 */
  private unsubscribeConnection: (() => void) | null = null;
  private replyText: string | null = null;
  private soundLevel: number | null = null;
  /** 本次开麦以来的问答历史，追加不覆盖；startTurn() 清空，跟 replyText 各管各的
   * ——replyText 是当前这一轮的气泡内容，turns 是完整历史。 */
  private turns: ConversationTurnRecord[] = [];
  /** 免提长对话里已落屏的对白，追加用户句和助手句，供 UI 气泡展示。 */
  private messages: VoiceChatMessage[] = [];
  /** endTurn() 主动关闭连接期间为 true，让 handleClose 认出这是预期内的挂断。 */
  private endingCall = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** true 期间麦克风回调采到的帧不再往 WS 发；连接和录音本身不受影响。 */
  private muted = false;
  /** endTurn() 执行期间为 true：期间到达的服务端消息一律丢弃，防止挂断过程中
   * 半路杀出的下一轮 tts/reply 消息把已经开始归位的状态又改回去。也防止
   * endTurn() 被并发调用第二次（比如 voice.session.end 和用户点"结束对话"
   * 前后脚都到）。 */
  private endTurnInFlight = false;
  /** startTurn() 执行期间为 true：UI 上的 phase==='idle' 判断读的是上一次渲染
   * 的闭包，快速双击可能在第一次调用还没跑到 setState('connecting') 前就
   * 发出第二次调用。没有这道门槛，第二次会覆盖 this.connection 和
   * streamStartedWaiter，导致第一次的连接监听器永久泄漏，且两次调用互相
   * 抢 streamStartedWaiter 可能让其中一次永远卡住不再 resolve。 */
  private startTurnInFlight = false;
  /** 串起 startStream/pushChunk/endStream/stop 全部对原生播放模块的调用，保证
   * 严格按到达顺序执行——原生流式播放器要求顺序写入，并发调用容易乱序或被
   * 拒绝，且错误会被吞掉，界面上完全看不出来。只串 pushChunk 不够：
   * startStream() 内部有一个没人等的 await（配置原生播放器），如果紧跟着的
   * 第一块音频不排在它后面，可能在原生侧还没配置完时就到达。 */
  private playbackChain: Promise<void> = Promise.resolve();
  /** 取消时递增，让已经排队但尚未执行的旧流操作失效。 */
  private playbackGeneration = 0;
  /** Category events can arrive before the command result creates their local row. */
  private readonly pendingCategoryUpdates = new Map<string, ScheduleCategory>();
  /** 串起每条 voice.command.result 的本地落库；一次连续通话里模型可能连续触发多个
   * 工具调用（批量新建/删除），command.result 消息前后脚到达时若不排队，会有两个
   * applyCommandResultLocally() 同时各开一个 withExclusiveTransactionAsync（各自
   * 新建一条原生连接），互相踩 "database is locked" 甚至留下损坏的原生连接状态——
   * 跟 playbackChain 一个模式：不管上一条成功与否都排到下一条前面。 */
  private commandResultChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly unsubscribeAppState: () => void;

  constructor(
    private readonly options: AssistantApplicationOptions,
    private readonly deps: AssistantApplicationDependencies,
  ) {
    // 切到后台只暂停，不挂断——回到前台不自动恢复，跟手动暂停的恢复方式一致，
    // 避免用户没留意就发现麦克风自己开着。
    this.unsubscribeAppState = this.deps.appState.subscribe((next) =>
      this.handleAppStateChange(next),
    );
  }

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

  getSoundLevel(): number | null {
    return this.soundLevel;
  }

  getMessages(): readonly VoiceChatMessage[] {
    return this.messages;
  }

  getTurns(): readonly ConversationTurnRecord[] {
    return this.turns;
  }

  /** 打开连续会话：建连、开一次流、开始持续推流麦克风。 */
  async startTurn(): Promise<void> {
    if (this.startTurnInFlight) {
      return;
    }
    this.startTurnInFlight = true;
    try {
      this.replyText = null;
      this.soundLevel = null;
      this.turns = [];
      this.messages = [];
      // 上一通电话可能是在暂停期间被空闲超时兜底挂断的，muted 只在用户手动
      // togglePause() 里恢复；不在这里清一次，新开的电话会继承上一通的静音,
      // UI 显示 listening 但麦克风帧全被吞掉。
      this.muted = false;
      this.setState({ phase: 'connecting' });
      await this.connect();
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
          // capture.stop() 不保证之后不会再有一次迟到的回调（原生侧缓冲区排空的
          // 时序不受这边控制）；streamId 在 endTurn() 里和发 voice.stream.end 同一
          // 拍清空，迟到的音频块必须在这里挡住，否则服务端会因为收到不属于任何
          // 活跃流的音频帧而报错。暂停期间录音本身不停（恢复更快），只是采到的
          // 帧不再往外发。
          if (this.streamId === null || this.muted) {
            return;
          }
          connection.sendAudioFrame(chunk);
          this.soundLevel = soundLevel;
          this.notifyListeners();
        });
      } catch (error) {
        // 服务端这时候已经确认开流了（stream_id 拿到手了）：跟 endTurn() 一样的
        // 收尾——不发 voice.stream.end 并关掉连接，这条 session 就卡在"有一条
        // 活跃流"，重试会复用同一个连接，下一次 voice.stream.start 被服务端当
        // 已有活跃流拒绝。
        if (this.streamId !== null) {
          connection.send({ payload: { stream_id: this.streamId }, type: 'voice.stream.end' });
        }
        this.unsubscribeConnection?.();
        connection.close();
        this.streamId = null;
        this.unsubscribeConnection = null;
        this.connection = null;
        this.setState({ message: '录音启动失败', phase: 'error' });
        throw error;
      }
      this.setState({ conversationId, phase: 'listening' });
      this.armIdleTimer();
    } finally {
      this.startTurnInFlight = false;
    }
  }

  /** 关闭连续会话：关麦、结束流、断开连接。 */
  async endTurn(): Promise<void> {
    // 挂断可能同时从两个地方触发（用户点"结束对话" vs 服务端 voice.session.end），
    // 也可能在它还没跑完时被同一个来源再触发一次——不加门槛会重复关连接、
    // 重复发 voice.stream.end。
    if (this.endTurnInFlight) {
      return;
    }
    this.endTurnInFlight = true;
    this.clearIdleTimer();
    this.endingCall = true;
    try {
      await this.deps.capture.stop();
    } catch {
      // 原生停止失败也不能让挂断卡在半路——跟 dispose() 的兜底思路一致，
      // 后面几步（发 stream.end、关连接、状态归位）必须照常走完。
    }
    this.soundLevel = null;
    const connection = this.connection;
    try {
      if (connection !== null && this.streamId !== null) {
        connection.send({
          payload: { stream_id: this.streamId },
          type: 'voice.stream.end',
        });
      }
      this.unsubscribeConnection?.();
      connection?.close();
    } catch {
      // 收尾步骤失败也不能拦住下面的状态归位。
    } finally {
      this.streamId = null;
      this.unsubscribeConnection = null;
      this.connection = null;
      this.setState({ phase: 'idle' });
      this.endTurnInFlight = false;
    }
  }

  async dismissReply(): Promise<void> {
    this.replyText = null;
    this.currentAudioId = null;
    this.notifyListeners();
    await this.stopPlaybackImmediately();
  }

  /** 用户点圆圈暂停/恢复。暂停期间空闲计时器照常跑——忘记恢复也会兜底挂断。 */
  togglePause(): void {
    if (this.state.phase === 'paused') {
      this.muted = false;
      this.setState({ conversationId: this.conversationId, phase: 'listening' });
      return;
    }
    if (!PAUSABLE_PHASES.has(this.state.phase)) {
      return;
    }
    this.enterPaused();
  }

  private enterPaused(): void {
    this.muted = true;
    this.setState({ conversationId: this.conversationId, phase: 'paused' });
  }

  private handleAppStateChange(next: AppLifecycleStatus): void {
    if (next !== 'background' && next !== 'inactive') {
      return;
    }
    if (!PAUSABLE_PHASES.has(this.state.phase)) {
      return;
    }
    this.enterPaused();
  }

  dispose(): void {
    this.disposed = true;
    this.pendingCategoryUpdates.clear();
    this.clearIdleTimer();
    this.unsubscribeAppState();
    this.listeners.clear();
    // 连续模式麦克风开着的时间远长于按住说话的一次按住，组件卸载时更可能还在
    // 录，兜底停一下——失败也不影响清理连接。
    void this.deps.capture.stop().catch(() => {});
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = null;
    this.connection?.close();
    this.connection = null;
  }

  private async connect(): Promise<void> {
    // 定位放在开连接之前:服务端握手超时从 socket 打开那一刻起计时,原生定位
    // (尤其冷启动 GPS)可能耗时数秒,放在连接之后拿会把这段时间算进握手预算,
    // 导致 hello 送达前就被服务端以 1008 断开。超时兜底,拿不到就不带,不阻塞握手。
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const sample = await Promise.race([
      this.deps.location.getCurrentSample().catch(() => null),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), LOCATION_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timeoutId);

    // session.hello → session.ready 的握手已经在 transport.connect() 内部完成
    // （共享的 AuthenticatedWebSocketClient 负责，voice_mode 已经绑定在这个
    // 服务专属的 AuthenticatedVoiceTransport 实例上），这里拿到的就是已经
    // ready 的连接。
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
    // 挂断已经在路上：这之后到达的任何消息（典型场景是工具调用触发的下一轮
    // 回复消息，抢在 endTurn() 跑完前到达）都不该再改状态,不然会把已经开始
    // 归位的状态又改回"通话中"。
    if (this.endTurnInFlight) {
      return;
    }
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
      case 'voice.asr.completed':
        // 听到一句真实语音：这是空闲计时器真正要等的信号，重新给一个完整窗口。
        this.armIdleTimer();
        this.appendUserMessage(message.payload.transcript);
        this.turns = [
          ...this.turns,
          {
            id: message.request_id ?? `turn-${this.turns.length}`,
            replyText: null,
            transcript: message.payload.transcript,
          },
        ];
        this.notifyListeners();
        return;
      case 'voice.command.result': {
        const command: AppliedCommand = {
          operation: message.payload.operation,
          schedule: message.payload.schedule,
          schedules: message.payload.schedules,
          occurrence_overrides: message.payload.occurrence_overrides,
          status: message.payload.status,
        };
        // 状态立刻回到 listening（麦克风还开着），不等写库；message.ack 必须等
        // 写库成功后才发，避免向服务端谎报已落库。
        this.queueCommandResult(command, message.message_id);
        this.setState({ conversationId: message.conversation_id, phase: 'listening' });
        return;
      }
      case 'schedule.category.updated':
        void this.applyCategoryUpdate(message.payload.schedule_id, message.payload.category);
        return;
      case 'voice.dialogue.question':
        // 缺字段/地点歧义之类的追问，对当前这轮来说就是系统的回复——记进历史，
        // 不然标题过了这一阵子就变回通用文案，这句追问在记录里再也找不到。
        this.updateLastTurnReply(message.request_id, message.payload.speech_text);
        this.upsertAssistantMessage(message.payload.question_id, message.payload.speech_text);
        this.setState({
          conversationId: message.conversation_id,
          phase: 'asking',
          speechText: message.payload.speech_text,
        });
        return;
      case 'voice.dialogue.reply':
        this.replyText = message.payload.speech_text;
        this.updateLastTurnReply(message.request_id, message.payload.speech_text);
        this.upsertAssistantMessage(
          message.payload.reply_id,
          message.payload.speech_text,
          !message.payload.done,
        );
        this.notifyListeners();
        return;
      case 'voice.tts.start':
        this.playbackGeneration += 1;
        this.canceledAudioId = null;
        this.currentAudioId = message.audio_id;
        this.setState({ conversationId: message.conversation_id, phase: 'speaking' });
        this.chainPlayback(() =>
          this.deps.playback.startStream({
            encoding: 'pcm_s16le',
            sampleRateHz: message.payload.sample_rate_hz,
          }),
        );
        return;
      case 'voice.tts.end':
        // canceled 后服务端仍会补发同 id 的 tts.end；它不能收尾新流，也不能把
        // interrupted 状态提前改回 listening。
        if (
          (this.canceledAudioId !== null && message.audio_id === this.canceledAudioId) ||
          (this.currentAudioId !== null && message.audio_id !== this.currentAudioId)
        ) {
          return;
        }
        this.currentAudioId = null;
        this.canceledAudioId = null;
        this.chainPlayback(() => this.deps.playback.endStream());
        this.setState({ conversationId: message.conversation_id, phase: 'listening' });
        // 播报完成后给一个全新的窗口，对应"播报完成后进入短暂等待"——不用单独
        // 再搞一个计时器，这次重置就当作那个等待。
        this.armIdleTimer();
        return;
      case 'voice.tts.canceled':
        // 用户开口打断了正在播的回复：stop 必须绕过 playbackChain 立即执行，否则
        // 已排队的 PCM 会先继续喂给原生播放器；旧队列随后由代次检查丢弃。
        if (
          this.currentAudioId !== null &&
          (message.audio_id === '' || message.audio_id !== this.currentAudioId)
        ) {
          return;
        }
        this.canceledAudioId = message.audio_id || this.currentAudioId;
        this.currentAudioId = null;
        void this.stopPlaybackImmediately();
        this.setState({ conversationId: message.conversation_id, phase: 'interrupted' });
        return;
      case 'voice.session.end':
        // 模型识别到用户想结束对话（"结束对话"「先这样」等），走跟用户点
        // "结束对话"一样的路径。
        void this.endTurn();
        return;
      default:
        return;
    }
  }

  /** 跟 chainPlayback 一个模式：.catch(() => {}) 必须紧跟在同一条语句里同步接上——
   * 迟一拍再接（比如靠下一次 queueCommandResult 调用里的第二个 then 参数兜底）
   * 这段窗口期这个被拒绝的 promise 没有任何 handler，Node 的 unhandled rejection
   * 检测在下一次调用到达前就已经判定“没人接”，直接把整个进程带崩——不是理论
   * 风险，用一个会抛的 state 订阅者复现过。 */
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
    this.chainPlayback(() => this.deps.playback.pushChunk(chunk));
  }

  /** 把一次对原生播放模块的调用接到 playbackChain 末尾，保证上一次真正执行完
   * (不管成功与否)才轮到这一次；取消后旧代次的操作会被跳过。 */
  private chainPlayback(run: () => Promise<void>): void {
    const generation = this.playbackGeneration;
    this.playbackChain = this.playbackChain
      .then(async () => {
        if (generation !== this.playbackGeneration) {
          return;
        }
        await run();
      })
      .catch(() => {});
  }

  /** 立即清空原生播放器，并把后续新操作排在 stop 完成之后。 */
  private async stopPlaybackImmediately(): Promise<void> {
    this.playbackGeneration += 1;
    const stop = this.deps.playback.stop().catch(() => {});
    this.playbackChain = stop;
    await stop;
  }

  private handleClose(event: { code: number; reason: string }): void {
    // 必须先解绑再置空：endTurn() 也会解绑同一份订阅,但它是在 await
    // capture.stop() 之后才读 this.unsubscribeConnection 的——如果真实断线
    // 恰好在那段 await 期间发生,这里要是只置空不调用,三个监听器就会永远
    // 留在共享的 AuthenticatedWebSocketClient 上（这个服务实例本身跨每通
    // 电话复用,泄漏的监听器会让下一通电话的每条消息都被处理两次）。
    this.unsubscribeConnection?.();
    this.connection = null;
    this.unsubscribeConnection = null;
    // endTurn() 自己发起的关闭也会触发这个回调（WebSocket close 事件对主动关闭
    // 和被动断开一视同仁）；这种情况下 idle 状态已经是 endTurn() 设置好的最终
    // 结果，不能再被这里改写成 error。
    if (this.endingCall) {
      this.endingCall = false;
      return;
    }
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

  /** speech_text 是累计到目前为止的完整文字（不是增量），直接覆盖对应轮次即可。
   * 必须按 request_id 找到它真正所属的那一轮，不能想当然地假设"最后一轮"——
   * 麦克风连续开着，用户可能在上一轮的回复还没到达前就已经开口问了下一句，
   * asr.completed 先把新一轮 push 进 turns，这条迟到的回复到达时"最后一轮"
   * 已经变成了下一轮，会把上一轮的回复错记成下一轮的（下一轮回复还没来时
   * 显示的会是上一轮内容）。找不到匹配 id（服务端没带 request_id 这种理论上
   * 不该发生的情况）时退化成更新最后一轮，好歹不丢内容。 */
  private updateLastTurnReply(requestId: string | undefined, replyText: string): void {
    if (this.turns.length === 0) {
      return;
    }
    const targetIndex =
      requestId !== undefined ? this.turns.findIndex((turn) => turn.id === requestId) : -1;
    const index = targetIndex === -1 ? this.turns.length - 1 : targetIndex;
    this.turns = this.turns.map((turn, i) => (i === index ? { ...turn, replyText } : turn));
  }

  private appendUserMessage(transcript: string): void {
    const text = transcript.trim();
    if (text.length === 0) {
      return;
    }
    this.messages = [
      ...this.messages,
      { id: `user-${this.messages.length + 1}`, role: 'user', text },
    ];
    this.notifyListeners();
  }

  private upsertAssistantMessage(id: string, speechText: string, pending = false): void {
    const text = speechText.trim();
    if (text.length === 0) {
      return;
    }
    const next: VoiceChatMessage = pending
      ? { id, role: 'assistant', text, pending: true }
      : { id, role: 'assistant', text };
    const existing = this.messages.findIndex((message) => message.id === id);
    if (existing >= 0) {
      this.messages = this.messages.map((message, index) => (index === existing ? next : message));
      return;
    }
    this.messages = [...this.messages, next];
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => void this.endTurn(), SESSION_IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
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
