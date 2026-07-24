import type { UUID } from '../contracts/common';
import type {
  CreateWriteRequest,
  CreateWriteRequestResult,
  DecideWriteRequest,
  WriteDecisionResult,
} from '../contracts/writeRequest';
import { parseCreateWriteRequestResult, parseWriteDecisionResult } from '../contracts/validators';
import { HttpClient, httpClient } from '../core/http';

/** 负责所有手动 CRUD 的统一写入确认门禁。 */
export class WriteRequestApi {
  constructor(private readonly http: HttpClient = httpClient) {}

  /**
   * 创建待确认写入请求，只保存候选变更，不直接修改业务事实。
   * 对应 `POST /api/v1/write-requests`。
   */
  create(request: CreateWriteRequest): Promise<CreateWriteRequestResult> {
    return this.http.request<CreateWriteRequestResult>(
      '/write-requests',
      {
        body: request,
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
    return this.http.request<WriteDecisionResult>(
      `/write-requests/${encodeURIComponent(writeRequestId)}/decide`,
      {
        body: request,
        method: 'POST',
      },
      parseWriteDecisionResult,
    );
  }
}

export const writeRequestApi = new WriteRequestApi();
