export const AUTH_DIAGNOSTIC_COMPONENTS = Object.freeze([
  'websocket',
  'account-state',
  'schedule-view',
  'reminder-runtime',
  'session-store',
] as const);

export type AuthDiagnosticComponent = (typeof AUTH_DIAGNOSTIC_COMPONENTS)[number];

/** 诊断只携带固定事件和组件，不接受异常、账号、凭据或传输帧。 */
export interface AuthDiagnosticEvent {
  readonly component: AuthDiagnosticComponent;
  readonly event: 'auth.cleanup.failed';
}

export interface AuthDiagnostics {
  record(event: AuthDiagnosticEvent): void;
}

export const NOOP_AUTH_DIAGNOSTICS: AuthDiagnostics = Object.freeze({
  record: () => undefined,
});

/** 所有清理阶段共用同一个脱敏记录入口，诊断实现失败也不能阻断退出。 */
export function recordAuthCleanupFailure(
  diagnostics: AuthDiagnostics,
  component: AuthDiagnosticComponent,
): void {
  try {
    diagnostics.record({ component, event: 'auth.cleanup.failed' });
  } catch {
    // 诊断是旁路，不能改变认证清理结果。
  }
}
