export type ApiError = {
  code: string;
  message: string;
  details: Record<string, unknown> | null;
};

export type WsRequest<TType extends string, TPayload> = {
  type: TType;
  request_id: string;
  payload: TPayload;
};

export type WsSuccess<TType extends string, TPayload> = {
  type: TType;
  request_id: string;
  ok: true;
  payload: TPayload;
};

export type WsFailure<TType extends string> = {
  type: TType;
  request_id: string;
  ok: false;
  error: ApiError;
};
