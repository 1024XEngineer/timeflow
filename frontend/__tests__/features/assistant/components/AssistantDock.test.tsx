import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { AssistantDock } from '@/features/assistant/components/AssistantDock';

jest.mock('@/features/assistant/components/VoiceHoldButton', () => ({
  VoiceHoldButton: ({ onPress }: { onPress?: () => void }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <Pressable accessibilityLabel="mock-open-assistant" onPress={onPress}>
        <Text>voice-hold</Text>
      </Pressable>
    );
  },
}));

describe('AssistantDock', () => {
  it('hides when requested', () => {
    const { queryByText } = render(
      <AssistantDock hidden onOpen={jest.fn()} onVoiceEnd={jest.fn()} />,
    );
    expect(queryByText('voice-hold')).toBeNull();
  });

  it('shows the voice control when visible', () => {
    const onOpen = jest.fn();
    render(<AssistantDock onOpen={onOpen} onVoiceEnd={jest.fn()} />);
    fireEvent.press(screen.getByLabelText('mock-open-assistant'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
