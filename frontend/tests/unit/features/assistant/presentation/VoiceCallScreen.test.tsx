import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';

import { VoiceCallScreen } from '../../../../../src/features/assistant/presentation/VoiceCallScreen';

function renderScreen(overrides: Partial<Parameters<typeof VoiceCallScreen>[0]> = {}) {
  const props = {
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
    renderScreen({ title: '正在说话' });
    expect(screen.getByText('正在说话')).toBeTruthy();
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
    renderScreen({ status: 'paused' });
    expect(screen.getByLabelText('继续')).toBeTruthy();
    expect(screen.queryByLabelText('暂停')).toBeNull();
  });

  it('renders every past turn, not just the latest', () => {
    renderScreen({
      turns: [
        { id: 't1', replyText: '明天下午三点', transcript: '明天几点开会' },
        { id: 't2', replyText: null, transcript: '谁参加' },
      ],
    });
    expect(screen.getByText('明天几点开会')).toBeTruthy();
    expect(screen.getByText('明天下午三点')).toBeTruthy();
    expect(screen.getByText('谁参加')).toBeTruthy();
  });

  it('shows a placeholder in the history area when the call has no turns yet', () => {
    renderScreen({ turns: [] });
    expect(screen.queryByText('明天几点开会')).toBeNull();
    expect(screen.getByText('对话开始后，这里会显示完整记录')).toBeTruthy();
  });

  it('scrolls the history area when its content grows', () => {
    renderScreen({ turns: [{ id: 't1', replyText: null, transcript: '明天几点开会' }] });
    const history = screen.getByTestId('voice-call-history');

    expect(history.props.onContentSizeChange).toEqual(expect.any(Function));
    fireEvent(history, 'layout', {
      nativeEvent: { layout: { height: 400, width: 390, x: 0, y: 0 } },
    });
    fireEvent(history, 'contentSizeChange', 390, 240);
  });

  it.each(['ios', 'android', 'web'] as const)(
    'lets a tall history list scroll on %s instead of staying stretched',
    (os) => {
      const original = Platform.OS;
      Platform.OS = os;
      try {
        renderScreen({
          turns: [
            { id: 't1', replyText: '明天下午三点', transcript: '明天几点开会' },
            { id: 't2', replyText: '改到四点', transcript: '改时间' },
            { id: 't3', replyText: null, transcript: '谁参加' },
          ],
        });
        const history = screen.getByTestId('voice-call-history');
        fireEvent(history, 'layout', {
          nativeEvent: { layout: { height: 400, width: 390, x: 0, y: 0 } },
        });
        fireEvent(history, 'contentSizeChange', 390, 2000);
        expect(StyleSheet.flatten(history.props.contentContainerStyle)).toMatchObject({
          flexGrow: 0,
          justifyContent: 'flex-start',
        });
        fireEvent.scroll(history, {
          nativeEvent: {
            contentOffset: { x: 0, y: 0 },
            contentSize: { height: 2000, width: 390 },
            layoutMeasurement: { height: 400, width: 390 },
          },
        });
        fireEvent(history, 'contentSizeChange', 390, 2200);
        expect(screen.getByText('明天几点开会')).toBeTruthy();
        expect(screen.getByText('谁参加')).toBeTruthy();
      } finally {
        Platform.OS = original;
      }
    },
  );

  it('keeps a short history list from using the overflow layout', () => {
    renderScreen({ turns: [{ id: 't1', replyText: null, transcript: '明天几点开会' }] });
    const history = screen.getByTestId('voice-call-history');
    fireEvent(history, 'layout', {
      nativeEvent: { layout: { height: 400, width: 390, x: 0, y: 0 } },
    });
    fireEvent(history, 'contentSizeChange', 390, 120);
    expect(StyleSheet.flatten(history.props.contentContainerStyle).justifyContent).not.toBe(
      'flex-start',
    );
  });
});
