import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { PushToTalkBar } from '../../../../../src/features/assistant/presentation/PushToTalkBar';

describe('PushToTalkBar layout', () => {
  it('uses a light bordered input treatment in the idle state', () => {
    render(
      <PushToTalkBar
        disabled={false}
        isRecording={false}
        onPressIn={() => {}}
        onPressOut={() => {}}
        soundLevel={null}
      />,
    );

    const button = screen.getByRole('button');
    expect(StyleSheet.flatten(button.props.style)).toMatchObject({
      backgroundColor: '#F0F2EE',
      borderWidth: 1,
    });
  });
});
