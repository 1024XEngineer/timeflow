import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseTimelineItemsResult } from '../../src/api/contracts/validators';
import { ApiError } from '../../src/api/core/ApiError';
import { HttpClient } from '../../src/api/core/http';
import { mockTimeline, mockUserId } from './mockData';
import { createMockFetch, jsonResponse } from './testUtils';

describe('HttpClient latest Wiki contract', () => {
  it('parses direct JSON responses and injects Bearer authentication', async () => {
    const mock = createMockFetch([jsonResponse(mockTimeline)]);
    const client = new HttpClient({
      baseUrl: 'http://example.test/api/v1/',
      fetch: mock.fetch,
      getAccessToken: () => 'mock.jwt.token',
    });

    const result = await client.request(
      '/items/timeline',
      {
        query: {
          user_id: mockUserId,
          start_at: '2026-07-24T00:00:00+08:00',
          end_at: '2026-07-25T00:00:00+08:00',
        },
      },
      parseTimelineItemsResult,
    );

    assert.deepEqual(result, mockTimeline);
    assert.match(mock.requests[0].url, /items\/timeline\?/);
    assert.equal(mock.requests[0].headers.get('Authorization'), 'Bearer mock.jwt.token');
  });

  it('serializes JSON bodies without renaming snake_case fields', async () => {
    const response = {
      source_message_id: '5d0e1fca-dc6e-4ff4-ab7a-a161e8245585',
      client_message_id: 'client-message-01',
      source_url: null,
      status: 'accepted',
    };
    const mock = createMockFetch([jsonResponse(response, 202)]);
    const client = new HttpClient({
      baseUrl: 'http://example.test/api/v1',
      fetch: mock.fetch,
      getAccessToken: () => 'mock.jwt.token',
    });

    await client.request('/conversation/inputs', {
      method: 'POST',
      body: {
        client_message_id: 'client-message-01',
        modality: 'text',
        raw_content: '测试',
      },
    });

    assert.equal(mock.requests[0].headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(mock.requests[0].body)), {
      client_message_id: 'client-message-01',
      modality: 'text',
      raw_content: '测试',
    });
  });

  it('rejects protected requests before fetch when Access Token is missing', async () => {
    const mock = createMockFetch([]);
    const client = new HttpClient({
      baseUrl: 'http://example.test/api/v1',
      fetch: mock.fetch,
    });

    await assert.rejects(
      () => client.request('/auth/me'),
      (error: unknown) =>
        error instanceof ApiError && error.code === 'UNAUTHORIZED' && error.status === 401,
    );
    assert.equal(mock.requests.length, 0);
  });

  it('maps non-success HTTP responses without assuming an undocumented envelope', async () => {
    const mock = createMockFetch([
      jsonResponse({ error_code: 'VERSION_CONFLICT', message: '数据版本已变化' }, 409),
    ]);
    const client = new HttpClient({
      baseUrl: 'http://example.test/api/v1',
      fetch: mock.fetch,
      getAccessToken: () => 'mock.jwt.token',
    });

    await assert.rejects(
      () => client.request('/write-requests/id/decide'),
      (error: unknown) =>
        error instanceof ApiError && error.code === 'VERSION_CONFLICT' && error.status === 409,
    );
  });

  it('maps malformed successful output to CONTRACT_MISMATCH', async () => {
    const mock = createMockFetch([jsonResponse({ items: [{ title: '字段不完整' }] })]);
    const client = new HttpClient({
      baseUrl: 'http://example.test/api/v1',
      fetch: mock.fetch,
      getAccessToken: () => 'mock.jwt.token',
    });

    await assert.rejects(
      () => client.request('/items/timeline', {}, parseTimelineItemsResult),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'CONTRACT_MISMATCH' &&
        error.message.includes('response.items[0].id'),
    );
  });
});
