import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { BackButton } from '@/shared/components/BackButton';

describe('BackButton', () => {
  it('uses the default label and fires onPress', () => {
    const onPress = jest.fn();
    render(<BackButton onPress={onPress} />);
    fireEvent.press(screen.getByLabelText('返回'));
    expect(onPress).toHaveBeenCalled();
  });

  it('accepts a custom accessibility label', () => {
    render(<BackButton accessibilityLabel="关闭" onPress={jest.fn()} />);
    expect(screen.getByLabelText('关闭')).toBeTruthy();
  });
});
