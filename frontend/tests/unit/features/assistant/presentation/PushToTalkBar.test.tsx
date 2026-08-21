import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Vibration } from 'react-native';

import { PushToTalkBar } from '../../../../../src/features/assistant/presentation/PushToTalkBar';

describe('PushToTalkBar', () => {
  it('shows the idle label when not recording', () => {
    render(
      <PushToTalkBar
        disabled={false}
        isRecording={false}
        onPressIn={jest.fn()}
        onPressOut={jest.fn()}
        soundLevel={null}
      />,
    );

    expect(screen.getByText('按住说话')).toBeTruthy();
  });

  it('swaps the label for the wave display while recording', () => {
    render(
      <PushToTalkBar
        disabled={false}
        isRecording
        onPressIn={jest.fn()}
        onPressOut={jest.fn()}
        soundLevel={-20}
      />,
    );

    expect(screen.queryByText('按住说话')).toBeNull();
  });

  it('calls onPressIn and onPressOut for a press-and-hold gesture', () => {
    const onPressIn = jest.fn();
    const onPressOut = jest.fn();
    render(
      <PushToTalkBar
        disabled={false}
        isRecording={false}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        soundLevel={null}
      />,
    );

    const bar = screen.getByLabelText('按住说话');
    fireEvent(bar, 'pressIn');
    expect(onPressIn).toHaveBeenCalledTimes(1);
    expect(onPressOut).not.toHaveBeenCalled();

    fireEvent(bar, 'pressOut');
    expect(onPressOut).toHaveBeenCalledTimes(1);
  });

  it('gives immediate hold feedback and a short haptic pulse', () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
    render(
      <PushToTalkBar
        disabled={false}
        isRecording={false}
        onPressIn={jest.fn()}
        onPressOut={jest.fn()}
        soundLevel={null}
      />,
    );

    const bar = screen.getByLabelText('按住说话');
    fireEvent(bar, 'pressIn');

    expect(screen.getByText('松开结束')).toBeTruthy();
    expect(screen.getByText('滑到这里取消')).toBeTruthy();
    expect(
      StyleSheet.flatten(screen.getByTestId('push-to-talk-cancel-target').props.style),
    ).toMatchObject({ bottom: 88, position: 'absolute' });
    expect(screen.queryByText(/dp/)).toBeNull();
    expect(vibrate).toHaveBeenCalledWith(10);

    fireEvent(bar, 'pressOut');
    expect(screen.getByText('按住说话')).toBeTruthy();
    vibrate.mockRestore();
  });

  it('shows a fixed cancel target and vibrates once when the target is reached', () => {
    const onCancel = jest.fn();
    const onPressOut = jest.fn();
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
    render(
      <PushToTalkBar
        disabled={false}
        isRecording={false}
        onCancel={onCancel}
        onPressIn={jest.fn()}
        onPressOut={onPressOut}
        soundLevel={null}
      />,
    );

    const bar = screen.getByLabelText('按住说话');
    fireEvent(bar, 'pressIn', { nativeEvent: { pageY: 400 } });
    fireEvent(bar, 'pressMove', { nativeEvent: { pageY: 360 } });
    expect(screen.getByText('滑到这里取消')).toBeTruthy();

    fireEvent(bar, 'pressMove', { nativeEvent: { pageY: 324 } });
    expect(screen.getByText('松开取消')).toBeTruthy();
    expect(screen.getByText('已到取消位置')).toBeTruthy();
    expect(vibrate).toHaveBeenCalledTimes(2);

    fireEvent(bar, 'pressOut');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPressOut).not.toHaveBeenCalled();
    vibrate.mockRestore();
  });

  it('marks the control as accessibility-disabled while another voice mode is active', () => {
    render(
      <PushToTalkBar
        disabled
        isRecording={false}
        onPressIn={jest.fn()}
        onPressOut={jest.fn()}
        soundLevel={null}
      />,
    );

    expect(screen.getByLabelText('按住说话').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });
});
