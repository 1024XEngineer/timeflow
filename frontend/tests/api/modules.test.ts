import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpClient } from '../../src/api/core/http';
import { AuthApi } from '../../src/api/modules/authApi';
import { ConversationApi } from '../../src/api/modules/conversationApi';
import { GoalApi } from '../../src/api/modules/goalApi';
import { ItemApi } from '../../src/api/modules/itemApi';
import { ProfileApi } from '../../src/api/modules/profileApi';
import { WriteRequestApi } from '../../src/api/modules/writeRequestApi';
import {
  mockAuthSession,
  mockConversationMessages,
  mockCreateWriteRequestResult,
  mockCurrentUser,
  mockGoalId,
  mockInputAccepted,
  mockLongGoalDetail,
  mockLongGoalList,
  mockMessageId,
  mockSnapshot,
  mockTimeline,
  mockUserId,
  mockUserProfile,
  mockWriteDecisionResult,
  mockWriteRequestId,
} from './mockData';
import { createMockFetch, jsonResponse } from './testUtils';

function createClient(mock: ReturnType<typeof createMockFetch>): HttpClient {
  return new HttpClient({
    baseUrl: 'http://example.test/api/v1',
    fetch: mock.fetch,
    getAccessToken: () => 'mock.jwt.token',
  });
}

describe('REST modules follow the latest Wiki paths and fields', () => {
  it('wraps register, login, and the renamed GET /auth/me interface', async () => {
    const mock = createMockFetch([
      jsonResponse(mockAuthSession, 201),
      jsonResponse(mockAuthSession),
      jsonResponse(mockCurrentUser),
    ]);
    const api = new AuthApi(createClient(mock));

    await api.register({
      email: 'user@example.com',
      password: 'StrongPassword123!',
      display_name: '浩涛',
    });
    await api.login({ email: 'user@example.com', password: 'StrongPassword123!' });
    await api.getCurrentUser();

    assert.equal(mock.requests[0].url, 'http://example.test/api/v1/auth/register');
    assert.equal(mock.requests[0].headers.get('Authorization'), null);
    assert.equal(mock.requests[1].url, 'http://example.test/api/v1/auth/login');
    assert.equal(mock.requests[2].url, 'http://example.test/api/v1/auth/me');
  });

  it('submits text and media through the single conversation input endpoint', async () => {
    const mediaAccepted = {
      ...mockInputAccepted,
      client_message_id: 'client-message-02',
      source_url: 'https://oss.example.test/audio/voice.m4a',
    };
    const mock = createMockFetch([
      jsonResponse(mockInputAccepted, 202),
      jsonResponse(mediaAccepted, 202),
    ]);
    const api = new ConversationApi(createClient(mock));

    await api.submitText({
      client_message_id: 'client-message-01',
      modality: 'text',
      raw_content: '明天下午三点开会',
    });
    await api.submitMedia({
      client_message_id: 'client-message-02',
      modality: 'audio',
      file: new Blob(['mock-audio'], { type: 'audio/mp4' }),
      file_name: 'voice.m4a',
    });

    assert.equal(mock.requests[0].url, 'http://example.test/api/v1/conversation/inputs');
    assert.deepEqual(JSON.parse(String(mock.requests[0].body)), {
      client_message_id: 'client-message-01',
      modality: 'text',
      raw_content: '明天下午三点开会',
    });
    assert.equal(mock.requests[1].url, 'http://example.test/api/v1/conversation/inputs');
    assert.ok(mock.requests[1].body instanceof FormData);
    const formData = mock.requests[1].body;
    assert.deepEqual([...formData.keys()].sort(), ['client_message_id', 'file', 'modality']);
    assert.equal(formData.get('modality'), 'audio');
    assert.equal(mock.requests[1].headers.get('Content-Type'), null);
  });

  it('loads message history and the separate initial-page snapshot', async () => {
    const mock = createMockFetch([
      jsonResponse(mockConversationMessages),
      jsonResponse(mockSnapshot),
    ]);
    const api = new ConversationApi(createClient(mock));

    await api.getMessages({
      user_id: mockUserId,
      before_message_id: mockMessageId,
      limit: 20,
    });
    await api.getSnapshot({
      user_id: mockUserId,
      last_seen_message_id: mockMessageId,
    });

    assert.match(mock.requests[0].url, /conversation\/messages\?/);
    assert.match(mock.requests[0].url, new RegExp(`before_message_id=${mockMessageId}`));
    assert.doesNotMatch(mock.requests[0].url, /cursor=/);
    assert.match(mock.requests[1].url, /conversation\/snapshot\?/);
  });

  it('queries only the documented timeline endpoint for task items', async () => {
    const mock = createMockFetch([jsonResponse(mockTimeline)]);
    const api = new ItemApi(createClient(mock));

    const result = await api.getTimeline({
      user_id: mockUserId,
      start_at: '2026-07-24T00:00:00+08:00',
      end_at: '2026-07-25T00:00:00+08:00',
      item_type: 'schedule',
    });

    assert.deepEqual(result, mockTimeline);
    assert.match(mock.requests[0].url, /\/items\/timeline\?/);
    assert.match(mock.requests[0].url, /item_type=schedule/);
  });

  it('wraps the renamed long-goal list and detail endpoints', async () => {
    const mock = createMockFetch([
      jsonResponse(mockLongGoalList),
      jsonResponse(mockLongGoalDetail),
    ]);
    const api = new GoalApi(createClient(mock));

    await api.getLongGoals({ user_id: mockUserId, status: 'active' });
    await api.getLongGoal(mockGoalId, { user_id: mockUserId });

    assert.match(mock.requests[0].url, /\/long-goals\?/);
    assert.equal(
      mock.requests[1].url,
      `http://example.test/api/v1/long-goals/${mockGoalId}?user_id=${mockUserId}`,
    );
  });

  it('queries the user profile and routes all manual writes through confirmation', async () => {
    const mock = createMockFetch([
      jsonResponse(mockUserProfile),
      jsonResponse(mockCreateWriteRequestResult, 201),
      jsonResponse(mockWriteDecisionResult),
    ]);
    const profileApi = new ProfileApi(createClient(mock));
    const writeApi = new WriteRequestApi(createClient(mock));

    await profileApi.getUserProfile({ user_id: mockUserId });
    await writeApi.create({
      action: 'create',
      target_type: 'task_item',
      payload: { title: '项目会议' },
      preview_text: '创建项目会议',
    });
    await writeApi.decide(mockWriteRequestId, {
      decision: 'confirmed',
      idempotency_key: 'decision-client-01',
    });

    assert.equal(
      mock.requests[0].url,
      `http://example.test/api/v1/user/profile?user_id=${mockUserId}`,
    );
    assert.equal(mock.requests[1].url, 'http://example.test/api/v1/write-requests');
    assert.equal(
      mock.requests[2].url,
      `http://example.test/api/v1/write-requests/${mockWriteRequestId}/decide`,
    );
    assert.deepEqual(JSON.parse(String(mock.requests[2].body)), {
      decision: 'confirmed',
      idempotency_key: 'decision-client-01',
    });
  });
});
