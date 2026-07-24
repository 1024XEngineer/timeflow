import type {
  ConversationInputAccepted,
  ConversationMessagesRequest,
  ConversationMessagesResult,
  ConversationSnapshot,
  ConversationSnapshotRequest,
  MediaConversationInputRequest,
  TextConversationInputRequest,
} from '../contracts/conversation';
import {
  parseConversationInputAccepted,
  parseConversationMessagesRequest,
  parseConversationMessagesResult,
  parseConversationSnapshot,
  parseConversationSnapshotRequest,
  parseMediaConversationInputRequest,
  parseTextConversationInputRequest,
} from '../contracts/validators';
import { HttpClient, httpClient, validateRequest } from '../core/http';

/** 负责统一输入提交、聊天历史加载和页面状态恢复。 */
export class ConversationApi {
  constructor(private readonly http: HttpClient = httpClient) {}

  /**
   * 提交文本输入并立即返回 accepted。
   * 母 AI 的处理进度和最终结果随后通过 WebSocket 推送。
   */
  submitText(request: TextConversationInputRequest): Promise<ConversationInputAccepted> {
    const validatedRequest = validateRequest(request, parseTextConversationInputRequest);
    return this.http.request<ConversationInputAccepted>(
      '/conversation/inputs',
      {
        body: validatedRequest,
        method: 'POST',
      },
      parseConversationInputAccepted,
    );
  }

  /**
   * 上传图片或音频输入。
   * 后端负责对象存储、生成 source_url，再调用 OCR 或 ASR。
   */
  submitMedia(request: MediaConversationInputRequest): Promise<ConversationInputAccepted> {
    const validatedRequest = validateRequest(request, parseMediaConversationInputRequest);
    const formData = new FormData();
    formData.append('client_message_id', validatedRequest.client_message_id);
    formData.append('modality', validatedRequest.modality);
    formData.append('file', validatedRequest.file, validatedRequest.file_name);
    if (validatedRequest.reply_to_question_id) {
      formData.append('reply_to_question_id', validatedRequest.reply_to_question_id);
    }

    return this.http.request<ConversationInputAccepted>(
      '/conversation/inputs',
      {
        body: formData,
        method: 'POST',
      },
      parseConversationInputAccepted,
    );
  }

  /** 按消息 ID 向前分页加载聊天历史。对应 `GET /conversation/messages`。 */
  getMessages(request: ConversationMessagesRequest): Promise<ConversationMessagesResult> {
    const validatedRequest = validateRequest(request, parseConversationMessagesRequest);
    return this.http.request<ConversationMessagesResult>(
      '/conversation/messages',
      {
        query: { ...validatedRequest },
      },
      parseConversationMessagesResult,
    );
  }

  /**
   * 页面首次打开或刷新时恢复持久化界面状态。
   * 该接口不替代 WS 断线后的 transport.resume。
   */
  getSnapshot(request: ConversationSnapshotRequest): Promise<ConversationSnapshot> {
    const validatedRequest = validateRequest(request, parseConversationSnapshotRequest);
    return this.http.request<ConversationSnapshot>(
      '/conversation/snapshot',
      {
        query: { ...validatedRequest },
      },
      parseConversationSnapshot,
    );
  }
}

export const conversationApi = new ConversationApi();
