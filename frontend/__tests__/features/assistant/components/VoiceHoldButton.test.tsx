import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Vibration } from 'react-native';

import { VoiceHoldButton } from '@/features/assistant/components/VoiceHoldButton';

describe('VoiceHoldButton', () => {
  it('renders the hold-to-talk control', () => {
    render(<VoiceHoldButton onVoiceEnd={jest.fn()} onVoiceStart={jest.fn()} />);
  });

  it('opens the assistant on a tap without starting or ending audio', () => {
    const onPress = jest.fn();
    const onVoiceStart = jest.fn();
    const onVoiceEnd = jest.fn();
    render(
      <VoiceHoldButton onPress={onPress} onVoiceEnd={onVoiceEnd} onVoiceStart={onVoiceStart} />,
    );

    fireEvent.press(screen.getByLabelText('轻点打开语音助手，按住说话，上滑取消'));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onVoiceStart).not.toHaveBeenCalled();
    expect(onVoiceEnd).not.toHaveBeenCalled();
  });

  it('starts on long press and ends when released', () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
    const onPress = jest.fn();
    const onVoiceStart = jest.fn();
    const onVoiceEnd = jest.fn();
    render(
      <VoiceHoldButton onPress={onPress} onVoiceEnd={onVoiceEnd} onVoiceStart={onVoiceStart} />,
    );
    const button = screen.getByLabelText('轻点打开语音助手，按住说话，上滑取消');
    const event = { nativeEvent: { pageY: 200 } };

    fireEvent(button, 'pressIn', event);
    fireEvent(button, 'longPress', event);
    fireEvent(button, 'pressOut', event);

    expect(onVoiceStart).toHaveBeenCalledTimes(1);
    expect(onVoiceEnd).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalledTimes(1);
    vibrate.mockRestore();
  });

  it('cancels a long press moved upward before release', () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
    const onVoiceCancel = jest.fn();
    render(
      <VoiceHoldButton
        onVoiceCancel={onVoiceCancel}
        onVoiceEnd={jest.fn()}
        onVoiceStart={jest.fn()}
      />,
    );
    const button = screen.getByLabelText('按住说话，松开发送，上滑取消');

    fireEvent(button, 'pressIn', { nativeEvent: { pageY: 200 } });
    fireEvent(button, 'longPress', { nativeEvent: { pageY: 200 } });
    fireEvent(button, 'touchMove', { nativeEvent: { pageY: 100 } });
    fireEvent(button, 'touchMove', { nativeEvent: { pageY: 90 } });
    fireEvent(button, 'pressOut', { nativeEvent: { pageY: 100 } });

    expect(onVoiceCancel).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(2);
    vibrate.mockRestore();
  });
});
