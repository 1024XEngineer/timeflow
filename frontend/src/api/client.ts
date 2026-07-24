import type { HttpRequestOptions } from './core/http';
import { API_BASE_URL, httpClient } from './core/http';
import type { ContractParser } from './core/validation';

/**
 * 兼容旧调用方式的统一请求入口；新代码应优先使用按业务划分的 API 模块。
 *
 * @deprecated Prefer the domain modules exported from `src/api`.
 */
export function apiFetch<T>(
  path: string,
  options?: HttpRequestOptions,
  parseData?: ContractParser<T>,
): Promise<T> {
  return httpClient.request<T>(path, options, parseData);
}

export { API_BASE_URL };
