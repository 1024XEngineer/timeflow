import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { ConnectionStatus, SessionHello, SessionReady, WsJsonMessage } from '@/contracts';

import { FakeWsServer } from '@/dev/fakes/FakeWsServer';
import { getOrCreateDeviceId, type DeviceIdStore } from '@/infrastructure/storage/deviceIdStore';
import { WsClient } from '@/infrastructure/ws/WsClient';

import {
  buildSessionWebSocketUrl,
  resolveAllowFakeWs,
  resolveSessionUserId,
} from './sessionEndpoint';

export type SessionTransportMode = 'remote' | 'fake' | 'unavailable';

export type SessionContextValue = {
  deviceId: string | null;
  userId: string | null;
  connectionStatus: ConnectionStatus;
  transportMode: SessionTransportMode;
  /** 每次成功 session.ready 递增，供 schedule 重连后 resync。 */
  sessionEpoch: number;
  client: WsClient | null;
  fakeServer: FakeWsServer | null;
  connectionError: string | null;
};

const SessionContext = createContext<SessionContextValue | null>(null);

function resolveWsUrl(): string | null {
  const fromEnv =
    typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_WS_URL?.trim() : undefined;
  return fromEnv || null;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const SESSION_READY_TIMEOUT_MS = 10_000;
const UNAVAILABLE_CONNECTION_ERROR =
  '缺少 EXPO_PUBLIC_WS_URL。可设置 EXPO_PUBLIC_USE_FAKE_WS=true 使用进程内 Fake（含托管预览）。';

function isSessionReady(message: WsJsonMessage, deviceId: string): message is SessionReady {
  return (
    message.type === 'session.ready' &&
    message.device_id === deviceId &&
    (message.user_id == null ||
      (typeof message.user_id === 'string' && message.user_id.trim().length > 0)) &&
    typeof message.server_time === 'string'
  );
}

export function SessionProvider({
  children,
  deviceIdStore,
}: {
  children: ReactNode;
  deviceIdStore?: DeviceIdStore;
}) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const url = useMemo(() => resolveWsUrl(), []);
  const allowFake = useMemo(
    () =>
      resolveAllowFakeWs(
        typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_USE_FAKE_WS : undefined,
      ),
    [],
  );
  const transportMode: SessionTransportMode = url ? 'remote' : allowFake ? 'fake' : 'unavailable';

  const remoteEndpoint = useMemo(() => {
    if (transportMode !== 'remote' || !url || !deviceId) {
      return { url: null, error: null };
    }
    try {
      return { url: buildSessionWebSocketUrl(url, deviceId), error: null };
    } catch (error) {
      return {
        url: null,
        error: error instanceof Error ? error.message : 'WebSocket 地址不合法',
      };
    }
  }, [deviceId, transportMode, url]);

  const { client, fakeServer } = useMemo(() => {
    if (transportMode === 'unavailable') {
      return { client: null as WsClient | null, fakeServer: null as FakeWsServer | null };
    }
    if (transportMode === 'remote' && !remoteEndpoint.url) {
      return { client: null as WsClient | null, fakeServer: null as FakeWsServer | null };
    }
    const server = transportMode === 'fake' ? new FakeWsServer() : null;
    const ws = new WsClient({
      url: transportMode === 'remote' ? remoteEndpoint.url : null,
      fakeHandler: server ? server.handleMessage : undefined,
    });
    server?.attach(ws);
    return { client: ws, fakeServer: server };
  }, [remoteEndpoint.url, transportMode]);

  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getOrCreateDeviceId(deviceIdStore)
      .then((id) => {
        if (!cancelled) setDeviceId(id);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setConnectionStatus('error');
        setConnectionError(
          error instanceof Error ? error.message : '无法初始化设备身份，请检查原生存储配置',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [deviceIdStore]);

  useEffect(() => {
    if (!client) return;
    if (!deviceId) return;

    let cancelled = false;
    let sessionReadyTimer: ReturnType<typeof setTimeout> | null = null;

    const clearReconnect = () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };

    const clearSessionReadyTimer = () => {
      if (!sessionReadyTimer) return;
      clearTimeout(sessionReadyTimer);
      sessionReadyTimer = null;
    };

    const sendHello = () => {
      const hello: SessionHello = {
        type: 'session.hello',
        device_id: deviceId,
        app_version: '1.0.0',
      };
      clearSessionReadyTimer();
      sessionReadyTimer = setTimeout(() => {
        if (cancelled) return;
        setConnectionStatus('error');
        setConnectionError('会话握手超时，请检查服务连接');
        client.close();
      }, SESSION_READY_TIMEOUT_MS);
      client.sendJson(hello);
    };

    const connectOnce = async () => {
      try {
        setConnectionError(null);
        await client.connect();
        if (cancelled) return;
        reconnectAttempt.current = 0;
        sendHello();
      } catch (error) {
        if (cancelled) return;
        clearSessionReadyTimer();
        client.close();
        setConnectionStatus('error');
        setConnectionError(error instanceof Error ? error.message : 'WebSocket 连接失败');
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || transportMode === 'fake') return;
      clearReconnect();
      const attempt = reconnectAttempt.current;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      reconnectAttempt.current = attempt + 1;
      setConnectionStatus('reconnecting');
      reconnectTimer.current = setTimeout(() => {
        void connectOnce();
      }, delay);
    };

    const unsubscribeStatus = client.onStatus((status) => {
      if (cancelled) return;
      // WebSocket open 只代表 socket 可用；session.ready 才代表身份握手完成。
      setConnectionStatus(status === 'ready' ? 'connecting' : status);
      if (status === 'closed') {
        clearSessionReadyTimer();
        scheduleReconnect();
      }
    });

    const unsubscribeMessage = client.onMessage((message) => {
      if (message instanceof ArrayBuffer) return;
      if (isSessionReady(message, deviceId)) {
        clearSessionReadyTimer();
        setUserId(resolveSessionUserId(message.user_id));
        setSessionEpoch((value) => value + 1);
        setConnectionStatus('ready');
        setConnectionError(null);
        return;
      }
      if (message.type === 'session.error') {
        clearSessionReadyTimer();
        setConnectionStatus('error');
        setConnectionError(
          typeof message.error === 'object' &&
            message.error !== null &&
            'message' in message.error &&
            typeof message.error.message === 'string'
            ? message.error.message
            : '会话握手失败',
        );
      }
    });

    void connectOnce();

    return () => {
      cancelled = true;
      clearReconnect();
      clearSessionReadyTimer();
      unsubscribeStatus();
      unsubscribeMessage();
      client.close();
    };
  }, [client, deviceId, transportMode]);

  const effectiveConnectionStatus: ConnectionStatus =
    transportMode === 'unavailable' || remoteEndpoint.error || (connectionError && !client)
      ? 'error'
      : client
        ? connectionStatus
        : 'connecting';
  const effectiveConnectionError =
    transportMode === 'unavailable'
      ? UNAVAILABLE_CONNECTION_ERROR
      : (remoteEndpoint.error ?? connectionError);

  const value = useMemo<SessionContextValue>(
    () => ({
      deviceId,
      userId,
      connectionStatus: effectiveConnectionStatus,
      transportMode,
      sessionEpoch,
      client,
      fakeServer,
      connectionError: effectiveConnectionError,
    }),
    [
      client,
      deviceId,
      effectiveConnectionError,
      effectiveConnectionStatus,
      fakeServer,
      sessionEpoch,
      transportMode,
      userId,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used within SessionProvider');
  }
  return value;
}
