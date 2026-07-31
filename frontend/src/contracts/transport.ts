export type ConnectionStatus =
  'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed' | 'error';

export type WsJsonMessage = {
  type: string;
  request_id?: string;
  [key: string]: unknown;
};
