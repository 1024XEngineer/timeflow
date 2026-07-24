import type { ISODate, ISODateTime, JsonObject, JsonValue, UUID } from '../contracts/common';

/**
 * 业务响应解析器的统一签名。
 *
 * `value` 是 HTTP `data` 或 WebSocket `payload` 的原始值；`path` 用于生成
 * 可直接定位字段的错误信息，例如 `data.items[0].version`。
 */
export type ContractParser<T> = (value: unknown, path: string) => T;

/** 契约不匹配错误，只描述字段位置和原因，不携带服务端内部信息。 */
export class ContractValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ContractValidationError';
    this.path = path;
  }
}

export function parseObject(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractValidationError(path, '必须是对象');
  }

  const object = value as Record<string, unknown>;
  // 严格模式：缺少必填字段或出现文档未声明字段都视为契约不一致。
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);

  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new ContractValidationError(`${path}.${key}`, '缺少必填字段');
    }
  }

  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      throw new ContractValidationError(`${path}.${key}`, '包含文档未声明的字段');
    }
  }

  return object;
}

export function parseString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new ContractValidationError(path, '必须是字符串');
  }
  return value;
}

export function parseNonEmptyString(value: unknown, path: string): string {
  const parsed = parseString(value, path);
  if (parsed.trim().length === 0) {
    throw new ContractValidationError(path, '不得为空');
  }
  return parsed;
}

export function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ContractValidationError(path, '必须是布尔值');
  }
  return value;
}

export function parseInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ContractValidationError(path, '必须是整数');
  }
  return value;
}

export function parseEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const parsed = parseString(value, path);
  if (!allowed.includes(parsed as T)) {
    throw new ContractValidationError(path, `必须是 ${allowed.join(' | ')} 之一`);
  }
  return parsed as T;
}

export function parseArray<T>(value: unknown, path: string, parser: ContractParser<T>): T[] {
  if (!Array.isArray(value)) {
    throw new ContractValidationError(path, '必须是数组');
  }
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}

export function parseNullable<T>(
  value: unknown,
  path: string,
  parser: ContractParser<T>,
): T | null {
  return value === null ? null : parser(value, path);
}

export function parseUuid(value: unknown, path: string): UUID {
  const parsed = parseString(value, path);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new ContractValidationError(path, '必须是 UUID 字符串');
  }
  return parsed;
}

export function parseIsoDate(value: unknown, path: string): ISODate {
  const parsed = parseString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || Number.isNaN(Date.parse(`${parsed}T00:00:00Z`))) {
    throw new ContractValidationError(path, '必须是 YYYY-MM-DD 日期');
  }
  return parsed;
}

export function parseIsoDateTime(value: unknown, path: string): ISODateTime {
  const parsed = parseString(value, path);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed) ||
    Number.isNaN(Date.parse(parsed))
  ) {
    throw new ContractValidationError(path, '必须是包含时区偏移的 ISO 8601 时间');
  }
  return parsed;
}

export function parseJsonValue(value: unknown, path: string): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => parseJsonValue(item, `${path}[${index}]`));
  }

  if (typeof value === 'object') {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = parseJsonValue(item, `${path}.${key}`);
    }
    return result;
  }

  throw new ContractValidationError(path, '必须是合法 JSON 值');
}

export function parseJsonObject(value: unknown, path = 'data'): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractValidationError(path, '必须是 JSON 对象');
  }
  return parseJsonValue(value, path) as JsonObject;
}
