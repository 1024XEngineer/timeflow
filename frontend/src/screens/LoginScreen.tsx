import { StatusBar } from 'expo-status-bar';
import { useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  AuthAccessError,
  type AuthAccess,
  type AuthAccessResponse,
  type AuthErrorCode,
} from '../contracts/auth';
import { colors, spacing } from '../shared/ui/theme';

interface LoginScreenProps {
  authAccess: AuthAccess;
  onAuthenticated?: (response: AuthAccessResponse) => void;
}

interface FormErrors {
  username?: string;
  password?: string;
}

type FocusedField = 'username' | 'password' | null;

const AUTH_ERROR_MESSAGES: Partial<Record<AuthErrorCode, string>> = {
  AUTH_INVALID_CREDENTIALS: '用户名或密码错误',
  AUTH_INVALID_PASSWORD: '密码格式不正确',
  AUTH_INVALID_USERNAME: '用户名格式不正确',
};

export function LoginScreen({ authAccess, onAuthenticated }: LoginScreenProps) {
  const passwordInputRef = useRef<TextInput>(null);
  const { width: windowWidth } = useWindowDimensions();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [focusedField, setFocusedField] = useState<FocusedField>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  function updateUsername(value: string) {
    setUsername(value);
    setSubmitError(undefined);
    if (errors.username) {
      setErrors((current) => ({ ...current, username: undefined }));
    }
  }

  function updatePassword(value: string) {
    setPassword(value);
    setSubmitError(undefined);
    if (errors.password) {
      setErrors((current) => ({ ...current, password: undefined }));
    }
  }

  async function handleSubmit() {
    if (isSubmitting) {
      return;
    }

    const normalizedUsername = username.trim();
    const nextErrors: FormErrors = {};

    if (!normalizedUsername) {
      nextErrors.username = '请输入用户名';
    }
    if (!password) {
      nextErrors.password = '请输入密码';
    } else if (password.length < 8) {
      nextErrors.password = '密码至少需要 8 个字符';
    }

    setErrors(nextErrors);
    setSubmitError(undefined);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await authAccess({ username: normalizedUsername, password });
      onAuthenticated?.(response);
    } catch (error) {
      setSubmitError(getSubmitErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.shell, { width: Math.min(windowWidth - spacing.xxl, 400) }]}>
          <View style={styles.brandRow} testID="brand-region">
            <View style={styles.brandMark} accessibilityElementsHidden>
              <Text style={styles.brandMarkText}>T</Text>
            </View>
            <Text style={styles.brandName}>Timeflow</Text>
          </View>

          <View style={styles.mainArea} testID="login-main">
            <View style={styles.heroIconWrap}>
              <Image
                accessibilityIgnoresInvertColors
                accessible={false}
                source={require('../../assets/icon.png')}
                style={styles.heroIcon}
                testID="hero-app-icon"
              />
            </View>

            <View style={styles.loginContent}>
              <View style={styles.intro}>
                <Text style={styles.title}>登录或注册</Text>
                <Text style={styles.subtitle}>首次使用会自动创建账号，已有账号将直接登录。</Text>
              </View>

              <View style={styles.formSurface}>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>用户名</Text>
                  <TextInput
                    accessibilityLabel="用户名"
                    autoCapitalize="none"
                    autoComplete="username"
                    autoCorrect={false}
                    editable={!isSubmitting}
                    enterKeyHint="next"
                    maxLength={128}
                    onBlur={() => setFocusedField(null)}
                    onChangeText={updateUsername}
                    onFocus={() => setFocusedField('username')}
                    onSubmitEditing={() => passwordInputRef.current?.focus()}
                    placeholder="输入用户名"
                    placeholderTextColor={colors.mutedText}
                    selectionColor={colors.focus}
                    style={[
                      styles.input,
                      focusedField === 'username' && styles.inputFocused,
                      errors.username && styles.inputError,
                    ]}
                    textContentType="username"
                    value={username}
                  />
                  {errors.username ? (
                    <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                      {errors.username}
                    </Text>
                  ) : null}
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>密码</Text>
                  <TextInput
                    ref={passwordInputRef}
                    accessibilityLabel="密码"
                    autoCapitalize="none"
                    autoComplete="current-password"
                    editable={!isSubmitting}
                    enterKeyHint="done"
                    maxLength={128}
                    onBlur={() => setFocusedField(null)}
                    onChangeText={updatePassword}
                    onFocus={() => setFocusedField('password')}
                    onSubmitEditing={handleSubmit}
                    placeholder="输入密码"
                    placeholderTextColor={colors.mutedText}
                    secureTextEntry
                    selectionColor={colors.focus}
                    style={[
                      styles.input,
                      focusedField === 'password' && styles.inputFocused,
                      errors.password && styles.inputError,
                    ]}
                    textContentType="password"
                    value={password}
                  />
                  {errors.password ? (
                    <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                      {errors.password}
                    </Text>
                  ) : null}
                </View>

                {submitError ? (
                  <Text accessibilityLiveRegion="polite" style={styles.submitError}>
                    {submitError}
                  </Text>
                ) : null}

                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isSubmitting }}
                  disabled={isSubmitting}
                  onPress={handleSubmit}
                  style={({ pressed }) => [
                    styles.loginButton,
                    isSubmitting && styles.loginButtonDisabled,
                    pressed && !isSubmitting && styles.loginButtonPressed,
                  ]}
                >
                  <Text style={styles.loginButtonText}>{isSubmitting ? '提交中…' : '继续'}</Text>
                </Pressable>
              </View>
            </View>
          </View>

          <Text style={styles.privacyNote} testID="privacy-note">
            你的日程只属于你，我们会认真保护账号信息。
          </Text>
        </View>
      </ScrollView>
      <StatusBar style="dark" />
    </KeyboardAvoidingView>
  );
}

function getSubmitErrorMessage(error: unknown): string {
  if (!(error instanceof AuthAccessError)) {
    return '登录或注册失败，请稍后重试';
  }
  if (error.reason === 'network') {
    return '无法连接服务器，请检查网络后重试';
  }
  if (error.code) {
    return AUTH_ERROR_MESSAGES[error.code] ?? '登录或注册失败，请稍后重试';
  }
  return '登录或注册失败，请稍后重试';
}

const styles = StyleSheet.create({
  brandMark: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 14,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  brandMarkText: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
  },
  brandName: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  brandRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  errorText: {
    color: colors.error,
    fontSize: 13,
    lineHeight: 18,
    marginTop: spacing.sm,
  },
  fieldGroup: {
    marginBottom: 20,
  },
  formSurface: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 24,
    borderWidth: 1,
    padding: spacing.lg,
  },
  heroIcon: {
    borderRadius: 24,
    height: 112,
    width: 112,
  },
  heroIconWrap: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  input: {
    backgroundColor: colors.input,
    borderColor: colors.input,
    borderRadius: 16,
    borderWidth: 2,
    color: colors.text,
    fontSize: 16,
    height: 56,
    paddingHorizontal: spacing.md,
  },
  inputError: {
    borderColor: colors.error,
  },
  inputFocused: {
    borderColor: colors.focus,
  },
  intro: {
    marginBottom: 28,
  },
  label: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  loginButton: {
    alignItems: 'center',
    backgroundColor: colors.text,
    borderRadius: 18,
    height: 58,
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  loginButtonDisabled: {
    opacity: 0.55,
  },
  loginButtonPressed: {
    opacity: 0.86,
    transform: [{ scale: 0.99 }],
  },
  loginButtonText: {
    color: colors.onPrimary,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  loginContent: {
    width: '100%',
  },
  mainArea: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: spacing.xl,
  },
  privacyNote: {
    color: colors.mutedText,
    fontSize: 13,
    lineHeight: 20,
    paddingHorizontal: spacing.md,
    textAlign: 'center',
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
  },
  shell: {
    alignSelf: 'center',
    flexGrow: 1,
  },
  submitError: {
    color: colors.error,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.mutedText,
    fontSize: 16,
    lineHeight: 24,
    marginTop: 10,
  },
  title: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.8,
    lineHeight: 39,
  },
});
