import { describe, expect, it } from '@jest/globals';

import {
  buildSessionWebSocketUrl,
  resolveAllowFakeWs,
  resolveSessionUserId,
} from '@/app/session/sessionEndpoint';

describe('session endpoint compatibility', () => {
  it('adds the persisted device id to the backend WebSocket URL', () => {
    expect(
      buildSessionWebSocketUrl('ws://127.0.0.1:8000/ws', 'device 1', { allowInsecure: true }),
    ).toBe('ws://127.0.0.1:8000/ws?device_id=device+1');
  });

  it('replaces a stale device id while preserving other query parameters', () => {
    expect(
      buildSessionWebSocketUrl('wss://api.example.com/ws?token=test&device_id=stale', 'current'),
    ).toBe('wss://api.example.com/ws?token=test&device_id=current');
  });

  it('rejects non-WebSocket URLs', () => {
    expect(() => buildSessionWebSocketUrl('http://127.0.0.1:8000/ws', 'device_1')).toThrow(
      '必须使用 ws:// 或 wss://',
    );
  });

  it('rejects plaintext WebSocket endpoints in release mode', () => {
    expect(() =>
      buildSessionWebSocketUrl('ws://api.example.com/ws', 'device_1', {
        allowInsecure: false,
      }),
    ).toThrow('发布构建的 EXPO_PUBLIC_WS_URL 必须使用 wss://');
  });

  it('uses the MVP backend user when session.ready omits user_id', () => {
    expect(resolveSessionUserId(undefined)).toBe('default_user');
    expect(resolveSessionUserId(' user_1 ')).toBe('user_1');
  });

  it('allows an explicit fake-ws opt-in outside __DEV__ for hosted previews', () => {
    expect(resolveAllowFakeWs('true', false)).toBe(true);
    expect(resolveAllowFakeWs('1', false)).toBe(true);
    expect(resolveAllowFakeWs('false', false)).toBe(false);
    expect(resolveAllowFakeWs(undefined, false)).toBe(false);
    expect(resolveAllowFakeWs(undefined, true)).toBe(true);
  });
});
