import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { RadialGradient } from 'react-native-svg';

import { VoiceCallScreen } from '../../../../../src/features/assistant/presentation/VoiceCallScreen';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 16, left: 0, right: 0, top: 12 }),
}));

function renderScreen(overrides: Partial<Parameters<typeof VoiceCallScreen>[0]> = {}) {
  const props = {
    messages: [],
    onCollapse: jest.fn(),
    onEnd: jest.fn(),
    onTogglePause: jest.fn(),
    status: 'listening' as const,
    title: '正在听',
    ...overrides,
  };
  render(<VoiceCallScreen {...props} />);
  return props;
}

describe('VoiceCallScreen', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the status title', () => {
    renderScreen({ title: '正在回复' });
    expect(screen.getByText('正在回复')).toBeTruthy();
  });

  it('renders user and assistant turns in the live transcript', () => {
    renderScreen({
      messages: [
        { id: 'u1', role: 'user', text: '明天下午三点开会' },
        { id: 'a1', role: 'assistant', text: '好，已经记下了' },
      ],
    });

    expect(screen.getByLabelText('你：明天下午三点开会')).toBeTruthy();
    expect(screen.getByLabelText('助手：好，已经记下了')).toBeTruthy();
    expect(screen.queryByText('你')).toBeNull();
    expect(screen.queryByText('助手')).toBeNull();
    expect(screen.getByText('明天下午三点开会')).toBeTruthy();
    expect(screen.getByText('好，已经记下了')).toBeTruthy();
  });

  it.each(['ios', 'android', 'web'] as const)('keeps the transcript readable on %s', (os) => {
    const original = Platform.OS;
    Platform.OS = os;
    try {
      renderScreen({
        messages: [{ id: 'u1', role: 'user', text: '改到四点' }],
        status: 'paused',
        title: '已暂停，点击圆圈继续',
      });
      expect(screen.getByText('改到四点')).toBeTruthy();
      expect(screen.getByText('已暂停，点击圆圈继续')).toBeTruthy();
    } finally {
      Platform.OS = original;
    }
  });

  it('collapses back to the bottom bar without ending the call', () => {
    const props = renderScreen();
    fireEvent.press(screen.getByLabelText('收起通话'));
    expect(props.onCollapse).toHaveBeenCalledTimes(1);
    expect(props.onEnd).not.toHaveBeenCalled();
  });

  it('ends the call without an interrupt control', () => {
    const props = renderScreen();
    expect(screen.queryByLabelText('打断当前对话')).toBeNull();
    fireEvent.press(screen.getByLabelText('结束对话'));
    expect(props.onEnd).toHaveBeenCalledTimes(1);
  });

  it('labels the center circle "暂停" while active and toggles pause on press', () => {
    const props = renderScreen({ status: 'listening' });
    const circle = screen.getByLabelText('暂停');
    fireEvent.press(circle);
    expect(props.onTogglePause).toHaveBeenCalledTimes(1);
  });

  it('labels the center circle "继续" once paused', () => {
    renderScreen({ status: 'paused', title: '已暂停，点击圆圈继续' });
    expect(screen.getByLabelText('继续')).toBeTruthy();
    expect(screen.queryByLabelText('暂停')).toBeNull();
    expect(screen.getByText('已暂停，点击圆圈继续')).toBeTruthy();
  });

  it('shows a speaking waveform on the live user or assistant turn', () => {
    renderScreen({
      messages: [{ id: 'u1', pending: true, role: 'user', text: '明天' }],
      status: 'paused',
      title: '已暂停，点击圆圈继续',
    });
    expect(screen.getByTestId('voice-call-speaking-wave-user')).toBeTruthy();
    expect(screen.queryByTestId('voice-call-orb-wave')).toBeNull();

    renderScreen({
      messages: [{ id: 'a1', pending: true, role: 'assistant', text: '好' }],
      status: 'paused',
      title: '已暂停，点击圆圈继续',
    });
    expect(screen.getByTestId('voice-call-speaking-wave-assistant')).toBeTruthy();
  });

  it('puts a live waveform inside the orb while listening or speaking', () => {
    renderScreen({ status: 'listening' });
    expect(screen.getByTestId('voice-call-orb-wave')).toBeTruthy();
    renderScreen({ status: 'speaking', title: '正在回复' });
    expect(screen.getAllByTestId('voice-call-orb-wave').length).toBeGreaterThan(0);
  });

  it('raises the center bars when the microphone is loud', () => {
    renderScreen({ soundLevel: -8, status: 'listening' });

    const edge = StyleSheet.flatten(screen.getByTestId('voice-call-voiceprint-bar-0').props.style);
    const center = StyleSheet.flatten(
      screen.getByTestId('voice-call-voiceprint-bar-4').props.style,
    );
    expect(center.height).toBeGreaterThan(edge.height as number);
  });

  it.each(['ios', 'android', 'web'] as const)(
    'keeps a vertically jumping voiceprint on %s',
    (os) => {
      const original = Platform.OS;
      Platform.OS = os;
      try {
        renderScreen({ soundLevel: -12, status: 'listening' });
        const edge = StyleSheet.flatten(
          screen.getByTestId('voice-call-voiceprint-bar-0').props.style,
        );
        const center = StyleSheet.flatten(
          screen.getByTestId('voice-call-voiceprint-bar-4').props.style,
        );
        expect(center.height).toBeGreaterThan(edge.height as number);
      } finally {
        Platform.OS = original;
      }
    },
  );

  it('grows the voiceprint taller when the microphone gets louder', () => {
    const { rerender } = render(
      <VoiceCallScreen
        messages={[]}
        onCollapse={jest.fn()}
        onEnd={jest.fn()}
        onTogglePause={jest.fn()}
        soundLevel={-40}
        status="listening"
        title="正在听"
      />,
    );
    const quieter = StyleSheet.flatten(
      screen.getByTestId('voice-call-voiceprint-bar-4').props.style,
    ).height as number;

    rerender(
      <VoiceCallScreen
        messages={[]}
        onCollapse={jest.fn()}
        onEnd={jest.fn()}
        onTogglePause={jest.fn()}
        soundLevel={-6}
        status="listening"
        title="正在听"
      />,
    );
    const louder = StyleSheet.flatten(screen.getByTestId('voice-call-voiceprint-bar-4').props.style)
      .height as number;
    expect(louder).toBeGreaterThan(quieter);
  });

  it('jumps the same bar up and down over time instead of sliding sideways', () => {
    jest.useFakeTimers();
    renderScreen({ soundLevel: -8, status: 'listening' });
    const before = StyleSheet.flatten(screen.getByTestId('voice-call-voiceprint-bar-4').props.style)
      .height as number;
    act(() => {
      jest.advanceTimersByTime(80);
    });
    const after = StyleSheet.flatten(screen.getByTestId('voice-call-voiceprint-bar-4').props.style)
      .height as number;
    expect(after).not.toBe(before);
  });

  it('keeps hangup available while connecting or after an interruption', () => {
    renderScreen({ status: 'busy', title: '连接中…' });
    expect(screen.getByText('连接中…')).toBeTruthy();
    expect(screen.getByLabelText('结束对话')).toBeTruthy();

    renderScreen({ status: 'interrupted', title: '已打断' });
    expect(screen.getByText('已打断')).toBeTruthy();
  });

  it('uses a deeper forest backdrop and a larger hangup control', () => {
    renderScreen({ status: 'paused', title: '已暂停，点击圆圈继续' });
    expect(
      StyleSheet.flatten(screen.getByTestId('voice-call-screen').props.style).backgroundColor,
    ).toBe('#0E241F');
    expect(screen.getByTestId('voice-call-backdrop')).toBeTruthy();
    expect(screen.UNSAFE_getByType(RadialGradient).props).toMatchObject({
      rx: '98%',
      ry: '92%',
    });
    expect(StyleSheet.flatten(screen.getByTestId('voice-call-end-icon').props.style)).toMatchObject(
      {
        height: 72,
        width: 72,
      },
    );
  });

  it.each(['ios', 'android', 'web'] as const)(
    'lets a tall transcript scroll on %s instead of staying flex-end',
    (os) => {
      const original = Platform.OS;
      Platform.OS = os;
      try {
        renderScreen({
          messages: [
            { id: 'u1', role: 'user', text: '明天下午三点开会' },
            { id: 'a1', role: 'assistant', text: '好，已经记下了' },
            { id: 'u2', role: 'user', text: '改到四点' },
            { id: 'a2', role: 'assistant', text: '已改到四点' },
          ],
          status: 'paused',
          title: '已暂停，点击圆圈继续',
        });
        const transcript = screen.getByTestId('voice-call-transcript');
        fireEvent(transcript, 'layout', {
          nativeEvent: { layout: { height: 400, width: 390, x: 0, y: 0 } },
        });
        fireEvent(transcript, 'contentSizeChange', 390, 2000);
        expect(StyleSheet.flatten(transcript.props.contentContainerStyle)).toMatchObject({
          flexGrow: 0,
          justifyContent: 'flex-start',
        });
        fireEvent.scroll(transcript, {
          nativeEvent: {
            contentOffset: { x: 0, y: 0 },
            contentSize: { height: 2000, width: 390 },
            layoutMeasurement: { height: 400, width: 390 },
          },
        });
        expect(screen.getByLabelText('你：明天下午三点开会')).toBeTruthy();
      } finally {
        Platform.OS = original;
      }
    },
  );

  it('keeps a short transcript pinned above the dock', () => {
    renderScreen({
      messages: [{ id: 'u1', role: 'user', text: '改到四点' }],
      status: 'paused',
      title: '已暂停，点击圆圈继续',
    });
    const transcript = screen.getByTestId('voice-call-transcript');
    fireEvent(transcript, 'layout', {
      nativeEvent: { layout: { height: 400, width: 390, x: 0, y: 0 } },
    });
    fireEvent(transcript, 'contentSizeChange', 390, 120);
    expect(StyleSheet.flatten(transcript.props.contentContainerStyle)).toMatchObject({
      flexGrow: 1,
      justifyContent: 'flex-end',
    });
  });

  it.each(['ios', 'android', 'web'] as const)('keeps the hangup control enlarged on %s', (os) => {
    const original = Platform.OS;
    Platform.OS = os;
    try {
      renderScreen({ status: 'paused', title: '已暂停，点击圆圈继续' });
      expect(StyleSheet.flatten(screen.getByTestId('voice-call-end-icon').props.style).height).toBe(
        72,
      );
      expect(screen.getByText('结束对话')).toBeTruthy();
    } finally {
      Platform.OS = original;
    }
  });
});
