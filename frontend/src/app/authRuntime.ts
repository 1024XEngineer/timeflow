import { AuthController } from '../features/auth/application';
import { accessAuth, createAuthSessionStore } from '../features/auth/data';

/** app 组合默认认证依赖，运行时实现不会渗透到展示或应用层。 */
export function createAuthController(): AuthController {
  return new AuthController({ authAccess: accessAuth, now: Date.now, store: createAuthSessionStore() });
}
