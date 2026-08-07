export type RuntimeModule = {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
};

/** 协调应用生命周期模块，不在应用层放置业务规则。 */
export class AppRuntime {
  private started = false;

  constructor(private readonly modules: readonly RuntimeModule[] = []) {}

  async start(): Promise<void> {
    if (this.started) return;

    for (const module of this.modules) {
      await module.start();
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    for (const module of [...this.modules].reverse()) {
      await module.stop();
    }
    this.started = false;
  }
}
