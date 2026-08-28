import * as Sentry from '@sentry/react-native';
import type { ErrorEvent } from '@sentry/core';
import { Platform } from 'react-native';
import type { ComponentType } from 'react';

import { boundOs } from '../../shared/observability';

const SENSITIVE_KEY =
  /title|transcript|latitude|longitude|session|account|speech|user|coord|schedule_id/i;

function readDsn(): string {
  return process.env.EXPO_PUBLIC_SENTRY_DSN?.trim() ?? '';
}

function scrubRecord(record: Record<string, unknown> | undefined): void {
  if (record == null) return;
  for (const key of Object.keys(record)) {
    if (SENSITIVE_KEY.test(key)) {
      delete record[key];
    }
  }
}

function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.user;
  scrubRecord(event.extra as Record<string, unknown> | undefined);
  scrubRecord(event.tags as Record<string, unknown> | undefined);
  return event;
}

/** 仅当设置了 EXPO_PUBLIC_SENTRY_DSN 时真正上报；未设置则 SDK 保持关闭。 */
export function initSentry(): void {
  const dsn = readDsn();
  Sentry.init({
    attachStacktrace: true,
    beforeSend(event: ErrorEvent) {
      return scrubEvent(event);
    },
    dsn: dsn || undefined,
    enableAutoPerformanceTracing: false,
    enabled: dsn.length > 0,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
  if (dsn.length > 0) {
    Sentry.setTag('os', boundOs(Platform.OS));
  }
}

export function wrapRoot(component: ComponentType): ComponentType {
  return Sentry.wrap(component as ComponentType<Record<string, unknown>>);
}
