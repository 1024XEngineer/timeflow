/**
 * 无业务语义的时间工具（附录 B.5）。
 * 不承载日程/提醒触发规则。
 */
export function toIsoUtc(date: Date = new Date()): string {
  return date.toISOString();
}

export function formatLocalDateTime(
  iso: string,
  timeZone = 'Asia/Shanghai',
  locale = 'zh-CN',
): string {
  try {
    return new Date(iso).toLocaleString(locale, { hour12: false, timeZone });
  } catch {
    return iso;
  }
}
