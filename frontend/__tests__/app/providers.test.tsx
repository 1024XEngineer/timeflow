import { describe, expect, it, jest } from '@jest/globals';
import { Platform, Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

jest.mock('@/app/session/SessionProvider', () => ({
  SessionProvider: ({ children }: { children: unknown }) => children,
  useSession: () => ({
    deviceId: 'device_test',
    userId: 'user_test',
    connectionStatus: 'ready',
    transportMode: 'fake',
    sessionEpoch: 1,
    client: {
      connect: async () => undefined,
      close: () => undefined,
      onStatus: () => () => undefined,
      onMessage: () => () => undefined,
      sendJson: () => undefined,
      request: async () => ({ ok: true }),
    },
    fakeServer: null,
    connectionError: null,
  }),
}));

jest.mock('@/features/schedule', () => ({
  ScheduleProvider: ({ children }: { children: unknown }) => children,
  useScheduleCommands: () => ({
    items: [],
    ready: true,
    mutation: { status: 'idle', error: null, pendingId: null },
    saveDraft: jest.fn(),
    toggleScheduleDone: jest.fn(),
    deleteSchedule: jest.fn(),
    service: {},
  }),
}));

jest.mock('@/app/overlay/OverlayProvider', () => ({
  OverlayProvider: ({ children }: { children: unknown }) => children,
  useOverlay: () => ({
    stack: [],
    push: jest.fn(),
    pop: jest.fn(),
    popKind: jest.fn(),
    isOpen: jest.fn(() => false),
    top: null,
  }),
}));

import { AppProviders } from '@/app/providers';

describe('AppProviders', () => {
  it('wraps children for native platforms', () => {
    const { getByText } = render(
      <AppProviders>
        <Text>child</Text>
      </AppProviders>,
    );
    expect(getByText('child')).toBeTruthy();
  });

  it('wraps web children in the desktop frame', () => {
    (Platform as { OS: string }).OS = 'web';
    render(
      <AppProviders>
        <Text>web-child</Text>
      </AppProviders>,
    );
    expect(screen.getByText('web-child')).toBeTruthy();
    (Platform as { OS: string }).OS = 'ios';
  });
});
