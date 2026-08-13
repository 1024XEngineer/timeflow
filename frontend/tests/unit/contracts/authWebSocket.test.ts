import { describe, expect, it } from '@jest/globals';

import {
  createSessionHello,
  parseSessionServerMessage,
} from '../../../src/contracts/authWebSocket';

describe('auth WebSocket contract', () => {
  it('creates the required first frame and parses a valid ready response', () => {
    expect(
      createSessionHello({
        accessToken: 'opaque-token',
        deviceId: 'device_001',
        requestId: 'req_001',
      }),
    ).toEqual({
      payload: { access_token: 'opaque-token', device_id: 'device_001' },
      request_id: 'req_001',
      type: 'session.hello',
    });
    expect(
      parseSessionServerMessage({
        ok: true,
        payload: { server_time: '2026-08-06T03:00:00+00:00', session_id: 'ws_session_001' },
        request_id: 'req_001',
        type: 'session.ready',
      }),
    ).toEqual({
      ok: true,
      payload: { server_time: '2026-08-06T03:00:00+00:00', session_id: 'ws_session_001' },
      request_id: 'req_001',
      type: 'session.ready',
    });
  });

  it('labels the coordinate system only when a location is provided', () => {
    expect(
      createSessionHello({
        accessToken: 'opaque-token',
        deviceId: 'device_001',
        location: { latitude: 39.9, longitude: 116.4 },
        requestId: 'req_001',
      }),
    ).toEqual({
      payload: {
        access_token: 'opaque-token',
        coordinate_system: 'WGS84',
        device_id: 'device_001',
        latitude: 39.9,
        longitude: 116.4,
      },
      request_id: 'req_001',
      type: 'session.hello',
    });
    expect(
      createSessionHello({
        accessToken: 'opaque-token',
        deviceId: 'device_001',
        requestId: 'req_001',
      }).payload,
    ).toEqual({ access_token: 'opaque-token', device_id: 'device_001' });
  });

  it.each([
    { code: 'UNAUTHENTICATED', retryable: true },
    { code: 'MALFORMED_MESSAGE', retryable: false },
  ] as const)('parses the frozen $code error response', ({ code, retryable }) => {
    expect(
      parseSessionServerMessage({
        error: { code, message: 'Session rejected', retryable },
        ok: false,
        request_id: 'req_001',
        type: 'session.error',
      }),
    ).toEqual({
      error: { code, message: 'Session rejected', retryable },
      ok: false,
      request_id: 'req_001',
      type: 'session.error',
    });
  });

  it.each([
    ['array', []],
    ['invalid JSON text', '{not-json'],
    ['invalid JSON shape', { ok: true, payload: {}, request_id: 'req_001', type: 'session.ready' }],
    ['unknown type', { ok: true, payload: {}, request_id: 'req_001', type: 'other' }],
    ['missing own request id', Object.create({ request_id: 'req_001' })],
    [
      'bad server time',
      {
        ok: true,
        payload: { server_time: 'today', session_id: 'ws_session_001' },
        request_id: 'req_001',
        type: 'session.ready',
      },
    ],
    [
      'unknown error code',
      {
        error: { code: 'OTHER', message: 'no', retryable: false },
        ok: false,
        request_id: 'req_001',
        type: 'session.error',
      },
    ],
    [
      'inherited error fields',
      {
        error: Object.create({ code: 'UNAUTHENTICATED', message: 'no', retryable: false }),
        ok: false,
        request_id: 'req_001',
        type: 'session.error',
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(parseSessionServerMessage(value)).toBeUndefined();
  });
});
