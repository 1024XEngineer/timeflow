import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type {
  ConnectionStatus,
  Schedule,
  ScheduleUpsertPayload as ScheduleDraft,
} from '@/contracts';

import type { AlarmPort } from '../application/AlarmPort';
import type { ScheduleConflictNotifier } from '../application/ScheduleNotificationPort';
import { ScheduleService } from '../application/ScheduleService';
import { ScheduleCache } from '../data/ScheduleCache';
import type { ScheduleTransport } from '../data/ScheduleTransport';
import { WsScheduleRepository } from '../data/WsScheduleRepository';

type ScheduleMutationState = {
  status: 'idle' | 'pending' | 'error';
  error: string | null;
  pendingId: string | null;
};

const IDLE_MUTATION: ScheduleMutationState = {
  status: 'idle',
  error: null,
  pendingId: null,
};

const EMPTY_SCHEDULES: Schedule[] = [];

type ReadySnapshot = {
  service: ScheduleService;
  sessionEpoch: number;
  userId: string;
};

type ScheduleCommandsValue = {
  items: Schedule[];
  ready: boolean;
  mutation: ScheduleMutationState;
  saveDraft: (draft: ScheduleDraft) => Promise<Schedule>;
  toggleScheduleDone: (schedule: Schedule) => Promise<void>;
  deleteSchedule: (schedule: Schedule) => Promise<void>;
  service: ScheduleService | null;
};

const ScheduleCommandsContext = createContext<ScheduleCommandsValue | null>(null);

export type ScheduleProviderProps = {
  alarmAdapter: AlarmPort;
  children: ReactNode;
  /** 由 app 从 SessionProvider 注入，feature 不反向依赖 app。 */
  client: ScheduleTransport | null;
  /** 当前 session 的连接状态；断线期间禁止写操作。 */
  connectionStatus: ConnectionStatus;
  /** App-owned feedback for server-reported schedule conflicts. */
  notifyConflicts?: ScheduleConflictNotifier;
  userId: string | null;
  /** 每次 session.ready 递增；用于重连后 resync。 */
  sessionEpoch: number;
};

export function ScheduleProvider({
  alarmAdapter,
  children,
  client,
  connectionStatus,
  notifyConflicts,
  userId,
  sessionEpoch,
}: ScheduleProviderProps) {
  const [readySnapshot, setReadySnapshot] = useState<ReadySnapshot | null>(null);
  const [mutation, setMutation] = useState<ScheduleMutationState>(IDLE_MUTATION);

  const service = useMemo(() => {
    if (!client) return null;
    const cache = new ScheduleCache();
    const repository = new WsScheduleRepository(client);
    return new ScheduleService({
      alarmAdapter,
      repository,
      cache,
      getUserId: () => {
        if (!userId) throw new Error('会话身份尚未就绪');
        return userId;
      },
      notifyConflicts,
    });
  }, [alarmAdapter, client, notifyConflicts, userId]);

  const subscribeToItems = useCallback(
    (onStoreChange: () => void) => {
      if (!service) return () => undefined;
      return service.subscribe(() => onStoreChange());
    },
    [service],
  );

  const getItemsSnapshot = useCallback(() => service?.getItems() ?? EMPTY_SCHEDULES, [service]);

  const items = useSyncExternalStore(subscribeToItems, getItemsSnapshot, getItemsSnapshot);

  useEffect(() => {
    return () => service?.dispose();
  }, [service]);

  useEffect(() => {
    if (!service || !userId || sessionEpoch === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        await service.resync();
        if (!cancelled) setReadySnapshot({ service, sessionEpoch, userId });
      } catch (error) {
        if (!cancelled) {
          setMutation({
            status: 'error',
            error: error instanceof Error ? error.message : '加载日程失败',
            pendingId: null,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service, userId, sessionEpoch]);

  const ready = Boolean(
    service &&
    connectionStatus === 'ready' &&
    userId &&
    readySnapshot?.service === service &&
    readySnapshot.userId === userId &&
    readySnapshot.sessionEpoch === sessionEpoch,
  );

  const runMutation = useCallback(
    async <T,>(
      pendingId: string,
      fallbackError: string,
      action: (activeService: ScheduleService) => Promise<T>,
    ): Promise<T> => {
      if (!service || !ready) {
        const error = new Error('日程服务尚未连接，请稍后重试');
        setMutation({ status: 'error', error: error.message, pendingId });
        throw error;
      }
      setMutation({ status: 'pending', error: null, pendingId });
      try {
        const result = await action(service);
        setMutation(IDLE_MUTATION);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : fallbackError;
        setMutation({ status: 'error', error: message, pendingId });
        throw error instanceof Error ? error : new Error(message);
      }
    },
    [ready, service],
  );

  const saveDraft = useCallback(
    (draft: ScheduleDraft) =>
      runMutation(draft.schedule_id ?? 'new', '保存失败', (active) => active.saveDraft(draft)),
    [runMutation],
  );

  const toggleScheduleDone = useCallback(
    (schedule: Schedule) =>
      runMutation(schedule.id, '更新失败', (active) => active.toggleDone(schedule)),
    [runMutation],
  );

  const deleteSchedule = useCallback(
    (schedule: Schedule) =>
      runMutation(schedule.id, '删除失败', (active) => active.deleteSchedule(schedule)),
    [runMutation],
  );

  const value = useMemo(
    () => ({
      items,
      ready,
      mutation,
      saveDraft,
      toggleScheduleDone,
      deleteSchedule,
      service,
    }),
    [deleteSchedule, items, mutation, ready, saveDraft, service, toggleScheduleDone],
  );

  return (
    <ScheduleCommandsContext.Provider value={value}>{children}</ScheduleCommandsContext.Provider>
  );
}

export function useScheduleCommands(): ScheduleCommandsValue {
  const value = useContext(ScheduleCommandsContext);
  if (!value) {
    throw new Error('useScheduleCommands must be used within ScheduleProvider');
  }
  return value;
}
