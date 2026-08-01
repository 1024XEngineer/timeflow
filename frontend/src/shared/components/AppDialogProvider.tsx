import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CircleAlert } from 'lucide-react-native';
import { Modal, Pressable, Text, View } from 'react-native';

import { colors } from '@/shared/theme';

import { appDialogStyles as styles } from './AppDialogProvider.styles';

export type AppDialogTone = 'default' | 'danger';

export type AppDialogOptions = {
  title: string;
  message: string;
  tone?: AppDialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
};

type DialogRequest = Required<Pick<AppDialogOptions, 'title' | 'message'>> &
  Pick<AppDialogOptions, 'tone' | 'confirmLabel' | 'cancelLabel'> & {
    id: string;
    mode: 'notice' | 'confirm';
    resolve: (confirmed: boolean) => void;
  };

type AppDialogContextValue = {
  showNotice: (options: AppDialogOptions) => Promise<void>;
  confirm: (options: AppDialogOptions) => Promise<boolean>;
};

const AppDialogContext = createContext<AppDialogContextValue | null>(null);

let dialogSequence = 0;

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const queueRef = useRef<DialogRequest[]>([]);
  const [active, setActive] = useState<DialogRequest | null>(null);

  const enqueue = useCallback(
    (mode: DialogRequest['mode'], options: AppDialogOptions): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const request: DialogRequest = {
          id: `dialog_${++dialogSequence}`,
          mode,
          title: options.title,
          message: options.message,
          tone: options.tone ?? 'default',
          confirmLabel: options.confirmLabel,
          cancelLabel: options.cancelLabel,
          resolve,
        };
        queueRef.current = [...queueRef.current, request];
        if (queueRef.current.length === 1) setActive(request);
      });
    },
    [],
  );

  const settle = useCallback((confirmed: boolean) => {
    const [current, ...rest] = queueRef.current;
    if (!current) return;
    queueRef.current = rest;
    setActive(rest[0] ?? null);
    current.resolve(confirmed);
  }, []);

  useEffect(() => {
    return () => {
      for (const request of queueRef.current) request.resolve(false);
      queueRef.current = [];
    };
  }, []);

  const value = useMemo<AppDialogContextValue>(
    () => ({
      showNotice: async (options) => {
        await enqueue('notice', options);
      },
      confirm: (options) => enqueue('confirm', options),
    }),
    [enqueue],
  );

  const isDanger = active?.tone === 'danger';
  const confirmLabel = active?.confirmLabel ?? (active?.mode === 'confirm' ? '确定' : '知道了');
  const cancelLabel = active?.cancelLabel ?? '取消';

  return (
    <AppDialogContext.Provider value={value}>
      {children}
      <Modal
        animationType="fade"
        onRequestClose={() => settle(false)}
        transparent
        visible={Boolean(active)}
      >
        <View style={styles.backdrop}>
          <Pressable
            accessibilityLabel="关闭提示"
            accessibilityRole="button"
            onPress={() => settle(false)}
            style={styles.dismiss}
          />
          {active ? (
            <View accessibilityViewIsModal style={styles.dialog}>
              <View style={[styles.icon, isDanger && styles.iconDanger]}>
                <CircleAlert
                  color={isDanger ? colors.coral : colors.deep}
                  size={20}
                  strokeWidth={2.2}
                />
              </View>
              <Text style={styles.title}>{active.title}</Text>
              <Text style={styles.message}>{active.message}</Text>
              <View style={styles.actions}>
                {active.mode === 'confirm' ? (
                  <Pressable
                    accessibilityLabel={cancelLabel}
                    accessibilityRole="button"
                    onPress={() => settle(false)}
                    style={[styles.action, styles.cancelAction]}
                  >
                    <Text style={styles.cancelText}>{cancelLabel}</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityLabel={confirmLabel}
                  accessibilityRole="button"
                  onPress={() => settle(true)}
                  style={[
                    styles.action,
                    styles.primaryAction,
                    active.mode === 'confirm' && isDanger && styles.dangerAction,
                  ]}
                >
                  <Text style={styles.primaryText}>{confirmLabel}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      </Modal>
    </AppDialogContext.Provider>
  );
}

export function useAppDialog(): AppDialogContextValue {
  const value = useContext(AppDialogContext);
  if (!value) {
    throw new Error('useAppDialog must be used within AppDialogProvider');
  }
  return value;
}
