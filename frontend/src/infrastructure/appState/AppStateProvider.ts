export type AppLifecycleStatus = 'active' | 'background' | 'inactive';

/** 订阅前后台切换的平台适配器。 */
export interface AppStateProvider {
  current(): AppLifecycleStatus;
  subscribe(listener: (status: AppLifecycleStatus) => void): () => void;
}
