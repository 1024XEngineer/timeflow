import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as Sentry from '@sentry/react-native';

import { initSentry, wrapRoot } from '../../../../src/infrastructure/observability/initSentry';

jest.mock('@sentry/react-native');

describe('initSentry', () => {
  const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

  afterEach(() => {
    if (originalDsn == null) {
      delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    } else {
      process.env.EXPO_PUBLIC_SENTRY_DSN = originalDsn;
    }
    jest.clearAllMocks();
  });

  it('stays disabled when the public DSN is unset', () => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    initSentry();
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        sendDefaultPii: false,
      }),
    );
  });

  it('enables the SDK when a DSN is present', () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@o0.ingest.sentry.io/1';
    initSentry();
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://public@o0.ingest.sentry.io/1',
        enabled: true,
        sendDefaultPii: false,
      }),
    );
    expect(Sentry.setTag).toHaveBeenCalledWith('os', expect.any(String));
  });

  it('strips titles, coordinates, and user ids before send', () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@o0.ingest.sentry.io/1';
    initSentry();
    const options = (Sentry.init as jest.Mock).mock.calls[0]?.[0] as {
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown>;
    };
    const scrubbed = options.beforeSend({
      extra: { title: '喝水提醒', outcome: 'native_ok' },
      tags: { schedule_id: 's1', manufacturer: 'xiaomi' },
      user: { id: 'acc_001' },
    });

    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.extra).toEqual({ outcome: 'native_ok' });
    expect(scrubbed.tags).toEqual({ manufacturer: 'xiaomi' });
  });

  it('leaves events without extra or tags untouched besides user', () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@o0.ingest.sentry.io/1';
    initSentry();
    const options = (Sentry.init as jest.Mock).mock.calls[0]?.[0] as {
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown>;
    };
    const scrubbed = options.beforeSend({ user: { id: 'acc_001' } });
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.tags).toBeUndefined();
  });

  it('wraps the root component through the SDK', () => {
    const Root = () => null;
    expect(wrapRoot(Root)).toBe(Root);
    expect(Sentry.wrap).toHaveBeenCalledWith(Root);
  });
});
