const FALLBACK_TITLE = '未命名日程';
const MAX_SPOKEN_TITLE_LENGTH = 80;

export type ReminderSpeechInput = {
  title: string;
  scheduledAt: string | null;
  timezone: string;
  isAllDay: boolean;
};

/** 生成交给系统 TTS 的简短提醒文案，不依赖预制音频。 */
export function buildReminderSpeechText(input: ReminderSpeechInput): string {
  const title = normalizeTitle(input.title);
  const scheduledTime = formatSpokenScheduleTime(input.scheduledAt, input.timezone, input.isAllDay);

  if (scheduledTime == null) {
    return `${title}，时间到了，请及时处理。`;
  }
  if (input.isAllDay) {
    return `${scheduledTime}，今天任务是${title}。`;
  }
  return `${title}，时间到了。现在已经${scheduledTime}了。`;
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return (normalized || FALLBACK_TITLE).slice(0, MAX_SPOKEN_TITLE_LENGTH);
}

function formatSpokenScheduleTime(
  iso: string | null,
  timezone: string,
  isAllDay: boolean,
): string | null {
  if (iso == null) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;

  try {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'long',
      hour: isAllDay ? undefined : '2-digit',
      minute: isAllDay ? undefined : '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(date);
    const value = (type: string): string =>
      parts.find((part) => part.type === type)?.value ?? '';
    const dateText = `${value('month')}月${value('day')}日`;
    if (isAllDay) return dateText;

    const hour = value('hour');
    const minute = value('minute');
    return minute === '00' ? `${hour}点` : `${hour}点${minute}分`;
  } catch {
    return null;
  }
}
