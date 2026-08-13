import { isTransportError, type AssistantServerMessage } from '../../../contracts/conversation';
import type { AppLifecycleStatus } from '../../../infrastructure/appState/AppStateProvider';
import type { AppliedCommand, ConversationTurnState } from '../domain/ConversationTurn';

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
  private readonly listeners = new Set<(state: ConversationTurnState) => void>();

  private conversationId: string | null = null;
  private streamId: string | null = null;
  /** 非 null 表示当前正处于 voice.tts.start 和 voice.tts.end/canceled 之间。 */
  private currentAudioId: string | null = null;
  private streamStartedWaiter: ((conversationId: string) => void) | null = null;
  /** 跟 streamStartedWaiter 配对；传输层报错/连接掉线时用它让等待方结束，不然会永远卡住。 */
  private streamStartRejecter: ((error: Error) => void) | null = null;
  /** connect() 里注册的三个监听器的统一取消订阅；dispose() 靠它把自己从共享连接上摘干净。 */
  private unsubscribeConnection: (() => void) | null = null;
  private replyText: string | null = null;
  private soundLevel: number | null = null;
  /** endTurn() 主动关闭连接期间为 true，让 handleClose 认出这是预期内的挂断。 */
  private endingCall = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** true 期间麦克风回调采到的帧不再往 WS 发；连接和录音本身不受影响。 */
  private muted = false;
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

  getReplyText(): string | null {
    return this.replyText;
  }

  getSoundLevel(): number | null {
    return this.soundLevel;
  }

  /** 打开连续会话：建连、开一次流、开始持续推流麦克风。 */
  async startTurn(): Promise<void> {
    this.replyText = null;
    this.soundLevel = null;
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
    this.setState({ conversationId, phase: 'listening' });
    this.armIdleTimer();
  }

  /** 关闭连续会话：关麦、结束流、断开连接。 */
  async endTurn(): Promise<void> {
    this.clearIdleTimer();
    this.endingCall = true;
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
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = null;
    connection?.close();
    this.connection = null;
    this.setState({ phase: 'idle' });
  }

  async dismissReply(): Promise<void> {
    this.replyText = null;
    this.currentAudioId = null;
    this.notifyListeners();
    await this.deps.playback.stop().catch(() => {});
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
        return;
      case 'voice.command.result': {
        const command: AppliedCommand = {
          operation: message.payload.operation,
          schedule: message.payload.schedule,
          schedules: message.payload.schedules,
          status: message.payload.status,
        };
        // 状态立刻回到 listening（麦克风还开着），不等写库；message.ack 必须等
        // 写库成功后才发，避免向服务端谎报已落库。
        void this.applyCommandResultLocally(command, message.message_id);
        this.setState({ conversationId: message.conversation_id, phase: 'listening' });
        return;
      }
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
        this.setState({ conversationId: message.conversation_id, phase: 'listening' });
        // 播报完成后给一个全新的窗口，对应"播报完成后进入短暂等待"——不用单独
        // 再搞一个计时器，这次重置就当作那个等待。
        this.armIdleTimer();
        return;
      case 'voice.tts.canceled':
        // 用户开口打断了正在播的回复：立刻丢掉播放端缓冲里还没放出来的音频，
        // 而不是等 voice.tts.end（后面仍会补发，但语义已经不是"正常说完"）。
        this.currentAudioId = null;
        void this.deps.playback.stop().catch(() => {});
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

  private async applyCommandResultLocally(
    command: AppliedCommand,
    messageId: string,
  ): Promise<void> {
    let writeSucceeded = true;
    try {
      await this.deps.localScheduleWriter.applyCommandResult(this.options.accountId, command);
    } catch {
      writeSucceeded = false;
      // 写失败不重试；不发 ack，避免向服务端谎报已落库。
    }
    if (writeSucceeded && this.connection !== null) {
      this.connection.send({ message_id: messageId, status: 'applied', type: 'message.ack' });
    }
    this.lastAppliedCommand = command;
    this.notifyListeners();
  }

  private handleAudioFrame(chunk: ArrayBuffer): void {
    if (this.currentAudioId === null) {
      return;
    }
    this.deps.playback.pushChunk(chunk).catch(() => {});
  }

  private handleClose(event: { code: number; reason: string }): void {
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
