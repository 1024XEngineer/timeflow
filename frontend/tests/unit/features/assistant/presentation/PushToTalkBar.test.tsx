import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

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
