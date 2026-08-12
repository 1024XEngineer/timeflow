export type RuntimeModule = {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
};

/** 协调应用生命周期模块，不在应用层放置业务规则。 */
export class AppRuntime {
  private started = false;
  /** 串行化 start/stop，避免并发重入与半开状态。 */
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(private readonly modules: readonly RuntimeModule[] = []) {}

  async start(): Promise<void> {
    const run = this.lifecycle.then(() => this.startInternal());
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async stop(): Promise<void> {
    const run = this.lifecycle.then(() => this.stopInternal());
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startInternal(): Promise<void> {
    if (this.started) return;

    const startedModules: RuntimeModule[] = [];
    try {
      for (const module of this.modules) {
        await module.start();
        startedModules.push(module);
      }
      this.started = true;
    } catch (error) {
      const cleanupErrors = await stopAllBestEffort([...startedModules].reverse());
      throw withCleanupErrors(error, cleanupErrors, 'AppRuntime start failed');
    }
  }

  private async stopInternal(): Promise<void> {
    if (!this.started) return;

    const stopErrors = await stopAllBestEffort([...this.modules].reverse());
    // 无论个别 stop 是否失败，都视为已退出 started，避免半关闭后重试重复 stop。
    this.started = false;
    if (stopErrors.length > 0) {
      throw withCleanupErrors(undefined, stopErrors, 'AppRuntime stop failed');
    }
  }
}

async function stopAllBestEffort(modules: readonly RuntimeModule[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const module of modules) {
    try {
      await module.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function withCleanupErrors(
  primary: unknown | undefined,
  cleanupErrors: readonly unknown[],
  message: string,
): Error {
  if (cleanupErrors.length === 0) {
    return primary instanceof Error ? primary : new Error(String(primary));
  }

  const parts: unknown[] = [];
  if (primary !== undefined) {
    parts.push(primary);
  }
  parts.push(...cleanupErrors);

  if (typeof AggregateError === 'function') {
    return new AggregateError(parts, message);
  }

  const detail = parts
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join('; ');
  const fallback = new Error(`${message}: ${detail}`);
  if (primary instanceof Error) {
    fallback.cause = primary;
  }
  return fallback;
}
