import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAuthSession,
  parseConversationInputAccepted,
  parseConversationMessagesResult,
  parseConversationServerEvent,
  parseLongGoal,
  parseTaskItem,
  parseWriteDecisionResult,
} from '../../src/api/contracts/validators';
import { ContractValidationError } from '../../src/api/core/validation';
import {
  mockAuthSession,
  mockConversationMessages,
  mockInputAccepted,
  mockLongGoal,
  mockProcessingEvent,
  mockTaskItem,
  mockWriteDecisionResult,
} from './mockData';

// 这些测试同时证明正确 Mock 可通过、旧字段和未声明字段会被拒绝。
describe('strict output structure and field validation', () => {
  it('accepts the exact latest auth fields and rejects old extra fields', () => {
    assert.deepEqual(parseAuthSession(mockAuthSession), mockAuthSession);
    assert.throws(
      () =>
        parseAuthSession({
          ...mockAuthSession,
          expires_at: '2026-07-24T18:00:00+08:00',
        }),
      (error: unknown) =>
        error instanceof ContractValidationError && error.message.includes('response.expires_at'),
    );
  });

  it('rejects the removed HTTP success/data envelope', () => {
    assert.throws(
      () =>
        parseConversationInputAccepted({
          success: true,
          data: mockInputAccepted,
        }),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        error.message.includes('response.source_message_id'),
    );
  });

  it('validates every ConversationMessageDTO field and nested metadata', () => {
    assert.deepEqual(
      parseConversationMessagesResult(mockConversationMessages),
      mockConversationMessages,
    );

    const invalid = structuredClone(mockConversationMessages);
    invalid.messages[0].metadata = {
      ...invalid.messages[0].metadata,
      database_row_id: 'not-documented',
    } as (typeof invalid.messages)[0]['metadata'];
    assert.throws(
      () => parseConversationMessagesResult(invalid),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        error.message.includes('metadata.database_row_id'),
    );
  });

  it('rejects old message fields and old modality enum values', () => {
    const message = mockConversationMessages.messages[0];
    const {
      id: _id,
      metadata: _metadata,
      message_index: _index,
      user_id: _userId,
      ...old
    } = message;

    assert.throws(
      () =>
        parseConversationMessagesResult({
          messages: [
            {
              ...old,
              message_id: message.id,
              modality: 'voice_asr',
              processing_status: 'succeeded',
            },
          ],
          has_more: false,
        }),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        error.message.includes('response.messages[0].id'),
    );
  });

  it('validates all TaskItemDTO fields, enums, UUIDs, and timestamps', () => {
    assert.deepEqual(parseTaskItem(mockTaskItem), mockTaskItem);
    assert.throws(
      () => parseTaskItem({ ...mockTaskItem, status: 'pending' }),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        error.message.includes('response.items[].status'),
    );
    assert.throws(
      () => parseTaskItem({ ...mockTaskItem, id: 'not-a-uuid' }),
      (error: unknown) =>
        error instanceof ContractValidationError && error.message.includes('response.items[].id'),
    );
    assert.throws(
      () => parseTaskItem({ ...mockTaskItem, start_at: '2026-07-24T15:00:00' }),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        error.message.includes('response.items[].start_at'),
    );
  });

  it('validates all LongGoalDTO fields and rejects undeclared fields', () => {
    assert.deepEqual(parseLongGoal(mockLongGoal), mockLongGoal);
    assert.throws(
      () => parseLongGoal({ ...mockLongGoal, is_deleted: false }),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        error.message.includes('response.goals[].is_deleted'),
    );
  });

  it('validates WriteDecisionResult status and field completeness', () => {
    assert.deepEqual(parseWriteDecisionResult(mockWriteDecisionResult), mockWriteDecisionResult);
    assert.throws(
      () => parseWriteDecisionResult({ ...mockWriteDecisionResult, status: 'pending' }),
      (error: unknown) =>
        error instanceof ContractValidationError && error.message.includes('response.status'),
    );
  });

  it('accepts type/timestamp/payload and rejects the old WS envelope', () => {
    assert.deepEqual(parseConversationServerEvent(mockProcessingEvent), mockProcessingEvent);
    assert.throws(
      () =>
        parseConversationServerEvent({
          event: 'processing',
          sent_at: mockProcessingEvent.timestamp,
          payload: mockProcessingEvent.payload,
        }),
      (error: unknown) =>
        error instanceof ContractValidationError && error.message.includes('event.type'),
    );
  });

  it('rejects undeclared fields inside a documented WS payload', () => {
    assert.throws(
      () =>
        parseConversationServerEvent({
          ...mockProcessingEvent,
          payload: {
            ...mockProcessingEvent.payload,
            message: '旧协议字段',
          },
        }),
      (error: unknown) =>
        error instanceof ContractValidationError && error.message.includes('event.payload.message'),
    );
  });
});
