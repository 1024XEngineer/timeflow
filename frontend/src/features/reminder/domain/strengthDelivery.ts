import type { LocalReminderSchedule, ReminderStrength } from './reminder';

/** 原生全屏响铃页的声音档位：none=不出声，ping=一次性短提示音，full=循环语音直到处理。 */
export type AlarmSoundTier = 'none' | 'ping' | 'full';

/** 提醒强度对应的客户端送达通道组合。 */
export type StrengthDeliveryPlan = {
  /** 只在原生全屏页不可用时的 JS 兜底路径里使用（iOS、或安卓侧原生模块拿不到）。 */
  useSystemNotification: boolean;
  usePopup: boolean;
  useVibration: boolean;
  /** JS 兜底路径专用的 TTS/本地音；跟 alarmSoundTier 是两回事，互不影响。 */
  useAudio: boolean;
  /** 原生全屏响铃页（presentNow / AlarmSoundService）用的声音档位。 */
  alarmSoundTier: AlarmSoundTier;
};

export function resolveStrengthDeliveryPlan(strength: ReminderStrength): StrengthDeliveryPlan {
  switch (strength) {
    case 'low':
      return {
        useSystemNotification: true,
        usePopup: false,
        useVibration: false,
        useAudio: false,
        alarmSoundTier: 'ping',
      };
    case 'medium':
      return {
        useSystemNotification: false,
        usePopup: true,
        useVibration: true,
        useAudio: false,
        alarmSoundTier: 'ping',
      };
    case 'high':
      return {
        useSystemNotification: false,
        usePopup: true,
        useVibration: true,
        useAudio: true,
        alarmSoundTier: 'full',
      };
  }
}

const FALLBACK_TITLE = '未命名日程';
const MAX_SPOKEN_TITLE_LENGTH = 80;

/**
 * 高强度提醒交给设备 TTS 念的文案：标题 + 播报时钟时间。非 high 或标题为空返回空串，
 * 原生按"无文案"回退打包铃。
 */
export function composeReminderSpeech(schedule: LocalReminderSchedule): string {
  if (schedule.reminder?.reminder_strength !== 'high') return '';
  const title = normalizeSpokenTitle(schedule.title);
  if (!title) return '';
  const scheduledTime = formatSpokenScheduleTime(
    schedule.start_time,
    schedule.timezone,
    schedule.is_all_day,
  );
  if (scheduledTime == null) {
    return `${title}，时间到了，请及时处理。`;
  }
  if (schedule.is_all_day) {
    return `${scheduledTime}，今天任务是${title}。`;
  }
  return `${title}，时间到了。现在已经${scheduledTime}了。`;
}

function normalizeSpokenTitle(value: string): string {
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
    const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    const dateText = `${value('month')}月${value('day')}日`;
    if (isAllDay) return dateText;

    const hour = value('hour');
    const minute = value('minute');
    return minute === '00' ? `${hour}点` : `${hour}点${minute}分`;
  } catch {
    return null;
  }
}
