export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
}

export interface MockFetch {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
}

/** 构造最新版接口直接返回的 JSON，不添加旧版 success/data 信封。 */
export function jsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 记录请求并按顺序返回 Mock 响应。 */
export function createMockFetch(responses: Response[]): MockFetch {
  const requests: RecordedRequest[] = [];
  const queue = [...responses];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body ?? null,
    });

    const response = queue.shift();
    if (!response) {
      throw new Error('Mock fetch response queue is empty');
    }
    return response;
  };

  return { fetch, requests };
}
