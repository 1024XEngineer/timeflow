import type { ApiErrorDetail, RequestId } from '../contracts/common';

/** 前端统一 API 异常，保留错误码、阶段、HTTP 状态和请求标识。 */
export class ApiError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly retryable: boolean;
  readonly requestId: RequestId | null;
  readonly status: number;

  constructor(
    detail: ApiErrorDetail,
    options: {
      status: number;
      requestId?: RequestId | null;
    },
  ) {
    super(detail.message);
    this.name = 'ApiError';
    this.code = detail.code;
    this.stage = detail.stage;
    this.retryable = detail.retryable;
    this.requestId = options.requestId ?? null;
    this.status = options.status;
  }
}
