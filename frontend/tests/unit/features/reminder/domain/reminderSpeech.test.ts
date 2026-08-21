import { describe, expect, it } from '@jest/globals';

import { buildReminderSpeechText } from '../../../../../src/features/reminder/domain/reminderSpeech';

describe('buildReminderSpeechText', () => {
  it('formats a timed reminder in its schedule timezone', () => {
    expect(
      buildReminderSpeechText({
        title: '晨会',
        scheduledAt: '2026-08-13T01:05:00.000Z',
        timezone: 'Asia/Shanghai',
        isAllDay: false,
      }),
    ).toBe('晨会，时间到了。现在已经09点05分了。');
  });

  it('formats an all-day reminder as a calendar date', () => {
    expect(
      buildReminderSpeechText({
        title: '提交报告',
        scheduledAt: '2026-08-13T01:05:00.000Z',
        timezone: 'Asia/Shanghai',
        isAllDay: true,
      }),
    ).toBe('8月13日，今天任务是提交报告。');
  });

  it('uses the generic wording when no schedule time is available', () => {
    expect(
      buildReminderSpeechText({
        title: '  喝水  ',
        scheduledAt: null,
        timezone: 'Asia/Shanghai',
        isAllDay: false,
      }),
    ).toBe('喝水，时间到了，请及时处理。');
  });

  it('uses the generic wording for an invalid timestamp', () => {
    expect(
      buildReminderSpeechText({
        title: '检查',
        scheduledAt: 'not-a-date',
        timezone: 'Asia/Shanghai',
        isAllDay: false,
      }),
    ).toBe('检查，时间到了，请及时处理。');
  });

  it('uses the generic wording when the timezone cannot be resolved', () => {
    expect(
      buildReminderSpeechText({
        title: '提醒',
        scheduledAt: '2026-08-13T01:05:00.000Z',
        timezone: 'Invalid/Timezone',
        isAllDay: false,
      }),
    ).toBe('提醒，时间到了，请及时处理。');
  });

  it('normalizes whitespace, supplies a fallback title, and truncates long titles', () => {
    const longTitle = 'a'.repeat(90);
    expect(
      buildReminderSpeechText({
        title: `  ${longTitle}  `,
        scheduledAt: null,
        timezone: 'UTC',
        isAllDay: false,
      }),
    ).toBe(`${'a'.repeat(80)}，时间到了，请及时处理。`);

    expect(
      buildReminderSpeechText({
        title: ' \n\t ',
        scheduledAt: null,
        timezone: 'UTC',
        isAllDay: false,
      }),
    ).toBe('未命名日程，时间到了，请及时处理。');
  });
});
