import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ScrollView, StyleSheet } from 'react-native';

import { VoiceCallScreen } from '../../../../../src/features/assistant/presentation/VoiceCallScreen';

let mockTopInset = 0;
let mockBottomInset = 0;

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: mockBottomInset, left: 0, right: 0, top: mockTopInset }),
}));

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
    mockTopInset = 0;
    mockBottomInset = 0;
  });

  it.each([
    ['keeps the default top padding on devices with a small top inset', 4, 16],
    ['pads the collapse button below a notch or status bar', 44, 44],
  ])('%s', (_name, topInset, expectedPaddingTop) => {
    mockTopInset = topInset;
    renderScreen();
    expect(
      StyleSheet.flatten(screen.getByTestId('voice-call-navigation').props.style),
    ).toMatchObject({ paddingTop: expectedPaddingTop });
  });

  it.each([
    ['keeps the default bottom padding on devices with a small home indicator', 4, 32],
    ['moves the call actions above the home indicator / gesture nav area', 34, 50],
  ])('%s', (_name, bottomInset, expectedPaddingBottom) => {
    mockBottomInset = bottomInset;
    renderScreen();
    expect(StyleSheet.flatten(screen.getByTestId('voice-call-actions').props.style)).toMatchObject({
      paddingBottom: expectedPaddingBottom,
    });
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

  it('scrolls the history area when its content grows', async () => {
    renderScreen({ turns: [{ id: 't1', replyText: null, transcript: '明天几点开会' }] });
    const history = screen.UNSAFE_getByType(ScrollView);

    expect(history.props.onContentSizeChange).toEqual(expect.any(Function));
    await act(async () => {
      history.props.onContentSizeChange();
      // 滚动被延后了两帧，测试要等这两帧都跑完再收尾，不然回调会在
      // jest 环境已经卸载之后才触发。
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  });
});
