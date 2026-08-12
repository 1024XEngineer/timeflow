import type { PropsWithChildren } from 'react';

import type { AuthController } from '../features/auth/application';
import { AuthProvider } from '../features/auth/presentation/AuthProvider';

/** 平台服务逐步接入后，在此组合应用级提供器。 */
export function AppProviders({ authController, children }: PropsWithChildren<{ authController: AuthController }>) {
  return <AuthProvider controller={authController}>{children}</AuthProvider>;
}
