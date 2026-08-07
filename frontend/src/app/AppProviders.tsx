import type { PropsWithChildren } from 'react';

/** 平台服务逐步接入后，在此组合应用级提供器。 */
export function AppProviders({ children }: PropsWithChildren) {
  return children;
}
