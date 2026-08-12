import type { AuthAccess } from '../contracts/auth';
import type { AuthSessionStore } from '../features/auth/application';
import { AuthController, AuthInvalidationCoordinator } from '../features/auth/application';
import { createAuthAccess, createAuthSessionStore } from '../features/auth/data';
import {
  createProtectedApiClient,
  createPublicApiClient,
  type ApiRequest,
  type CreateApiClientOptions,
} from '../infrastructure/network/client';

export interface AuthRuntime {
  readonly controller: AuthController;
  readonly invalidationCoordinator: AuthInvalidationCoordinator;
  readonly publicClient: ApiRequest;
  readonly protectedClient: ApiRequest;
}

export interface CreateAuthRuntimeOptions extends Pick<CreateApiClientOptions, 'fetch'> {
  readonly now?: () => number;
  readonly store?: AuthSessionStore;
}

/** app 只在此处组合认证控制器、失效协调器与 HTTP 入口。 */
export function createAuthRuntime(options: CreateAuthRuntimeOptions = {}): AuthRuntime {
  const now = options.now ?? Date.now;
  const store = options.store ?? createAuthSessionStore();
  let authAccess!: AuthAccess;
  const controller = new AuthController({
    authAccess: (request) => authAccess(request),
    now,
    store,
  });
  const invalidationCoordinator = new AuthInvalidationCoordinator({ controller, now });
  const clientOptions = { fetch: options.fetch, invalidationCoordinator };
  const publicClient = createPublicApiClient(clientOptions);
  const protectedClient = createProtectedApiClient(clientOptions);
  authAccess = createAuthAccess(publicClient);

  return {
    controller,
    invalidationCoordinator,
    protectedClient,
    publicClient,
  };
}

/** 保留根组件的简洁入口；业务 HTTP 由完整 runtime 注入。 */
export function createAuthController(): AuthController {
  return createAuthRuntime().controller;
}
