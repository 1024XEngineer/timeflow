export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:8000/api/v1'
).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

export class ApiResponseError extends Error {
  constructor(public readonly status: number) {
    super(`API response was not valid JSON for status ${status}`);
    this.name = 'ApiResponseError';
  }
}

export type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export const apiFetch: ApiRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_BASE_URL}${path}`, init);

  if (!response.ok) {
    throw new ApiError(response.status, await readJson(response));
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiResponseError(response.status);
  }
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
