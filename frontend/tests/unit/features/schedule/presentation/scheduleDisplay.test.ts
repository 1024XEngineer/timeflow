import { describe, expect, it } from '@jest/globals';

import {
  emptyAgendaMessage,
  formatAgendaSectionTitle,
} from '../../../../../src/features/schedule/presentation/scheduleDisplay';

describe('formatAgendaSectionTitle', () => {
  const today = new Date(2026, 7, 19);

  it('keeps 今日安排 for the selected day', () => {
    expect(formatAgendaSectionTitle(new Date(2026, 7, 19), today)).toBe('今日安排');
  });

  it('uses the calendar date for other days', () => {
    expect(formatAgendaSectionTitle(new Date(2026, 7, 13), today)).toBe('8月13日的安排');
  });
});

describe('emptyAgendaMessage', () => {
  const today = new Date(2026, 7, 19);
  const addPrompt = '留一点时间给自己，或用语音助手添加安排。';

  it('keeps the add prompt for today and future days', () => {
    expect(emptyAgendaMessage(new Date(2026, 7, 19), today)).toEqual({
      title: '这一天暂时没有日程',
      detail: addPrompt,
    });
    expect(emptyAgendaMessage(new Date(2026, 7, 20), today)).toEqual({
      title: '这一天暂时没有日程',
      detail: addPrompt,
    });
  });

  it('omits the add prompt for past days', () => {
    expect(emptyAgendaMessage(new Date(2026, 7, 13), today)).toEqual({
      title: '这一天是属于你的',
      detail: null,
    });
  });
});
