interface FakeAuthHttpResponse {
  readonly body: unknown;
  readonly status: number;
}

type FakeAuthHttpOutcome =
  | { readonly kind: 'json'; readonly response: Promise<FakeAuthHttpResponse> }
  | { readonly kind: 'network-error' };

export interface DeferredFakeAuthHttpResponse {
  resolve(status: number, body: unknown): void;
}

export interface FakeAuthHttpRequest {
  readonly headers: Headers;
  readonly init: RequestInit;
  readonly url: string;
}

/** 唯一 HTTP Fake：按队列返回固定 JSON 或固定网络错误，不输出请求和凭据。 */
export class FakeAuthHttpTransport {
  readonly requests: FakeAuthHttpRequest[] = [];
  private readonly outcomes: FakeAuthHttpOutcome[] = [];

  readonly fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    this.requests.push({ headers: new Headers(init.headers), init, url: String(input) });
    const outcome = this.outcomes.shift();
    if (!outcome) {
      throw new Error('FakeAuthHttpTransport response queue is empty');
    }
    if (outcome.kind === 'network-error') {
      throw new TypeError('Network request failed');
    }
    const { body, status } = await outcome.response;
    return {
      json: async () => body,
      ok: status >= 200 && status < 300,
      status,
    } as Response;
  }) as typeof globalThis.fetch;

  enqueueJson(status: number, body: unknown): void {
    this.outcomes.push({ kind: 'json', response: Promise.resolve({ body, status }) });
  }

  enqueueDeferredJson(): DeferredFakeAuthHttpResponse {
    let resolveResponse!: (response: FakeAuthHttpResponse) => void;
    const response = new Promise<FakeAuthHttpResponse>((resolve) => {
      resolveResponse = resolve;
    });
    this.outcomes.push({ kind: 'json', response });
    return { resolve: (status, body) => resolveResponse({ body, status }) };
  }

  enqueueNetworkError(): void {
    this.outcomes.push({ kind: 'network-error' });
  }
}
