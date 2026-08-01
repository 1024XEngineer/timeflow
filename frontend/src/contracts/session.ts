import type { ApiError } from './envelope';

export type SessionHello = {
  type: 'session.hello';
  device_id: string;
  app_version: string;
};

export type SessionReady = {
  type: 'session.ready';
  device_id: string;
  /** Newer servers return this; the current single-user MVP server omits it. */
  user_id?: string;
  server_time: string;
};

export type SessionError = {
  type: 'session.error';
  ok: false;
  error: ApiError;
};

export type LocationReport = {
  type: 'location.report';
  schedule_scope: 'current';
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: string;
};

export type LocationReportAck =
  | { type: 'location.report.ack'; ok: true }
  | { type: 'location.report.ack'; ok: false; error: ApiError };
