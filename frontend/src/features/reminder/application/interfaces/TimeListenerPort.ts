export type LocalTimeTick = {
  observed_at: string;
};

export type TimeListenerHandle = {
  listener_id: string;
};

export type TimeListenerOptions = {
  background: boolean;
};

/** 与平台无关的本地时间观测端口。 */
export interface TimeListenerPort {
  start(
    listener: (tick: LocalTimeTick) => void,
    options?: TimeListenerOptions,
  ): Promise<TimeListenerHandle>;
  stop(listenerId: string): Promise<void>;
}
