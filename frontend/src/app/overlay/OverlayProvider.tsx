import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { BackHandler } from 'react-native';
import { useEffect } from 'react';

export type OverlayKind =
  | 'standardCreate'
  | 'assistant'
  | 'locationPicker'
  | 'addressEditor'
  | 'datePicker'
  | 'timePicker'
  | 'scheduleDetail'
  | 'mapPicker';

export type OverlayEntry = {
  id: string;
  kind: OverlayKind;
  onClose?: () => void;
};

type OverlayContextValue = {
  stack: OverlayEntry[];
  push: (entry: Omit<OverlayEntry, 'id'> & { id?: string }) => string;
  pop: () => void;
  popKind: (kind: OverlayKind) => void;
  isOpen: (kind: OverlayKind) => boolean;
  top: OverlayEntry | null;
};

const OverlayContext = createContext<OverlayContextValue | null>(null);

let overlaySeq = 0;

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<OverlayEntry[]>([]);
  // Event handlers update this synchronously so multiple pop operations in
  // one event use the latest stack without putting callbacks in a state
  // updater (which React may invoke more than once in StrictMode).
  const stackRef = useRef<OverlayEntry[]>([]);

  const push = useCallback((entry: Omit<OverlayEntry, 'id'> & { id?: string }) => {
    const id = entry.id ?? `overlay_${++overlaySeq}`;
    const nextEntry = { ...entry, id };
    const nextStack = [...stackRef.current, nextEntry];
    stackRef.current = nextStack;
    setStack(nextStack);
    return id;
  }, []);

  const pop = useCallback(() => {
    const current = stackRef.current;
    const top = current[current.length - 1];
    if (!top) return;
    const nextStack = current.slice(0, -1);
    stackRef.current = nextStack;
    setStack(nextStack);
    top.onClose?.();
  }, []);

  const popKind = useCallback((kind: OverlayKind) => {
    const current = stackRef.current;
    const index = [...current].map((item) => item.kind).lastIndexOf(kind);
    if (index < 0) return;
    const removed = current[index];
    const nextStack = current.filter((_, i) => i !== index);
    stackRef.current = nextStack;
    setStack(nextStack);
    removed?.onClose?.();
  }, []);

  const isOpen = useCallback(
    (kind: OverlayKind) => stack.some((item) => item.kind === kind),
    [stack],
  );

  const top = stack.length > 0 ? stack[stack.length - 1]! : null;

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stackRef.current.length === 0) return false;
      pop();
      return true;
    });
    return () => subscription.remove();
  }, [pop]);

  const value = useMemo(
    () => ({ stack, push, pop, popKind, isOpen, top }),
    [isOpen, pop, popKind, push, stack, top],
  );

  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}

export function useOverlay(): OverlayContextValue {
  const value = useContext(OverlayContext);
  if (!value) {
    throw new Error('useOverlay must be used within OverlayProvider');
  }
  return value;
}
