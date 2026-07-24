import type { UUID } from '../contracts/common';
import type {
  CreateWriteRequest,
  CreateWriteRequestResult,
  DecideWriteRequest,
  WriteDecisionResult,
} from '../contracts/writeRequest';
import {
  parseCreateWriteRequest,
  parseCreateWriteRequestResult,
  parseDecideWriteRequest,
  parseWriteDecisionResult,
} from '../contracts/validators';
import { HttpClient, httpClient, validateRequest } from '../core/http';
import { parseUuid } from '../core/validation';

/** 负责所有手动 CRUD 的统一写入确认门禁。 */
export class WriteRequestApi {
  constructor(private readonly http: HttpClient = httpClient) {}

  /**
   * 创建待确认写入请求，只保存候选变更，不直接修改业务事实。
   * 对应 `POST /api/v1/write-requests`。
   */
  create(request: CreateWriteRequest): Promise<CreateWriteRequestResult> {
    const validatedRequest = validateRequest(request, parseCreateWriteRequest);
    return this.http.request<CreateWriteRequestResult>(
      '/write-requests',
      {
        body: validatedRequest,
        method: 'POST',
      },
      parseCreateWriteRequestResult,
    );
  }

  /**
   * 确认或拒绝写入；只有 confirmed 才允许后端校验后落库。
   * 对应 `POST /api/v1/write-requests/{write_request_id}/decide`。
   */
  decide(writeRequestId: UUID, request: DecideWriteRequest): Promise<WriteDecisionResult> {
    const validatedWriteRequestId = validateRequest(writeRequestId, parseUuid);
    const validatedRequest = validateRequest(request, parseDecideWriteRequest);
    return this.http.request<WriteDecisionResult>(
      `/write-requests/${encodeURIComponent(validatedWriteRequestId)}/decide`,
      {
        body: validatedRequest,
        method: 'POST',
      },
      parseWriteDecisionResult,
    );
  }
}

export const writeRequestApi = new WriteRequestApi();
