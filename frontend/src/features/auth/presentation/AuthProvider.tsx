import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';

import {
  type AuthController,
  type AuthInvalidationCoordinator,
  type AuthInvalidationReason,
} from '../application';
import type { AuthAccessRequest } from '../../../contracts/auth';
import type { AuthViewState } from '../domain';

interface AuthContextValue {
  readonly viewState: AuthViewState;
  readonly authenticate: (credentials: AuthAccessRequest) => Promise<void>;
  readonly invalidate: (reason: AuthInvalidationReason) => Promise<void>;
  readonly retryInitialization: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** 向 React 暴露脱敏快照和安全动作；控制器本身不离开认证边界。 */
export function AuthProvider({
  children,
  controller,
  invalidationCoordinator,
}: PropsWithChildren<{
  controller: AuthController;
  invalidationCoordinator?: AuthInvalidationCoordinator;
}>) {
  const viewState = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getViewState(),
    () => controller.getViewState(),
  );

  useEffect(() => {
    void controller.initialize();
  }, [controller]);

  const value = useMemo<AuthContextValue>(
    () => ({
      authenticate: (credentials) => controller.authenticate(credentials),
      invalidate: (reason) => invalidationCoordinator?.invalidate(reason) ?? controller.invalidate(reason),
      retryInitialization: () => controller.retryInitialization(),
      signOut: () => invalidationCoordinator?.invalidate('revoked') ?? controller.signOut(),
      viewState,
    }),
    [controller, invalidationCoordinator, viewState],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 认证展示与操作的唯一 React 入口，不暴露敏感会话。 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('AuthProvider is required');
  }
  return context;
}
