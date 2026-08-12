import { describe, expect, it } from 'vitest';

import { isAuthAccessResponse, parseAuthErrorEnvelope } from '../../src/contracts/auth';
import { createSessionHello, parseSessionServerMessage } from '../../src/contracts/authWebSocket';
import httpAccessSuccess from '../fixtures/auth/http-access-success.json';
import httpInvalidCredentials from '../fixtures/auth/http-invalid-credentials.json';
import httpInvalidToken from '../fixtures/auth/http-invalid-token.json';
import wsSessionHello from '../fixtures/auth/ws-session-hello.json';
import wsSessionMalformed from '../fixtures/auth/ws-session-malformed.json';
import wsSessionReady from '../fixtures/auth/ws-session-ready.json';
import wsSessionUnauthenticated from '../fixtures/auth/ws-session-unauthenticated.json';

describe('frozen authentication fixtures', () => {
  it('keeps the HTTP success and error fixtures aligned with the public parsers', () => {
    expect(isAuthAccessResponse(httpAccessSuccess)).toBe(true);
    expect(parseAuthErrorEnvelope(httpInvalidCredentials)).toEqual(httpInvalidCredentials);
    expect(parseAuthErrorEnvelope(httpInvalidToken)).toEqual(httpInvalidToken);
  });

  it('keeps the WebSocket hello builder and server parser aligned with fixtures', () => {
    expect(
      createSessionHello({
        accessToken: httpAccessSuccess.access_token,
        deviceId: wsSessionHello.payload.device_id,
        requestId: wsSessionHello.request_id,
      }),
    ).toEqual(wsSessionHello);
    expect(parseSessionServerMessage(wsSessionReady)).toEqual(wsSessionReady);
    expect(parseSessionServerMessage(wsSessionUnauthenticated)).toEqual(wsSessionUnauthenticated);
    expect(parseSessionServerMessage(wsSessionMalformed)).toEqual(wsSessionMalformed);
  });

  it('pins the shared expiration and server time values', () => {
    expect(httpAccessSuccess.expires_in).toBe(3600);
    expect(wsSessionReady.payload.server_time).toBe('2026-08-06T03:00:00+00:00');
  });
});
