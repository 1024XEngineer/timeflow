import { useState } from 'react';

import {
  AuthAccessError,
  type AuthAccess,
  type AuthAccessRequest,
  type AuthAccessResponse,
  type AuthErrorCode,
} from '../../../contracts/auth';

type AuthField = keyof AuthAccessRequest;
type FormErrors = Partial<Record<AuthField, string>>;

interface AuthAccessFormOptions {
  authAccess: AuthAccess;
  onAuthenticated?: (response: AuthAccessResponse) => void;
}

const INITIAL_VALUES: AuthAccessRequest = { password: '', username: '' };
const FALLBACK_ERROR_MESSAGE = '登录或注册失败，请稍后重试';

const AUTH_ERROR_MESSAGES: Partial<Record<AuthErrorCode, string>> = {
  AUTH_INVALID_CREDENTIALS: '用户名或密码错误',
  AUTH_INVALID_PASSWORD: '密码格式不正确',
  AUTH_INVALID_USERNAME: '用户名格式不正确',
};

/**
 * 统一登录或注册表单的状态、校验和提交编排。
 *
 * 页面只消费字段值、展示错误和提交动作，不需要重复理解认证错误或请求归一化规则。
 */
export function useAuthAccessForm({ authAccess, onAuthenticated }: AuthAccessFormOptions) {
  const [values, setValues] = useState<AuthAccessRequest>(INITIAL_VALUES);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  function updateField(field: AuthField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setSubmitError(undefined);
    setErrors((current) => clearFieldError(current, field));
  }

  async function submit() {
    if (isSubmitting) {
      return;
    }

    const request = { ...values, username: values.username.trim() };
    const nextErrors = validate(request);

    setErrors(nextErrors);
    setSubmitError(undefined);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await authAccess(request);
      onAuthenticated?.(response);
    } catch (error) {
      setSubmitError(getSubmitErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return { errors, isSubmitting, submit, submitError, updateField, values };
}

function validate(request: AuthAccessRequest): FormErrors {
  const errors: FormErrors = {};

  if (!request.username) {
    errors.username = '请输入用户名';
  }
  if (!request.password) {
    errors.password = '请输入密码';
  } else if (request.password.length < 8) {
    errors.password = '密码至少需要 8 个字符';
  }

  return errors;
}

function clearFieldError(errors: FormErrors, field: AuthField): FormErrors {
  if (!errors[field]) {
    return errors;
  }

  const nextErrors = { ...errors };
  delete nextErrors[field];
  return nextErrors;
}

function getSubmitErrorMessage(error: unknown): string {
  if (!(error instanceof AuthAccessError)) {
    return FALLBACK_ERROR_MESSAGE;
  }
  if (error.reason === 'network') {
    return '无法连接服务器，请检查网络后重试';
  }
  if (error.reason === 'timeout') {
    return '请求超时，请稍后重试';
  }
  return error.code
    ? (AUTH_ERROR_MESSAGES[error.code] ?? FALLBACK_ERROR_MESSAGE)
    : FALLBACK_ERROR_MESSAGE;
}
