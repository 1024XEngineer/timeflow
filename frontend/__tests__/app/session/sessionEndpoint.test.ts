import { describe, expect, it } from '@jest/globals';

import { buildSessionWebSocketUrl, resolveSessionUserId } from '@/app/session/sessionEndpoint';

describe('session endpoint compatibility', () => {
  it('adds the persisted device id to the backend WebSocket URL', () => {
    expect(buildSessionWebSocketUrl('ws://127.0.0.1:8000/ws', 'device 1')).toBe(
      'ws://127.0.0.1:8000/ws?device_id=device+1',
    );
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

  it('uses the MVP backend user when session.ready omits user_id', () => {
    expect(resolveSessionUserId(undefined)).toBe('default_user');
    expect(resolveSessionUserId(' user_1 ')).toBe('user_1');
  });
});
