import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';

import { TempoAssistantIcon } from '@/features/assistant/components/TempoAssistantIcon';

describe('TempoAssistantIcon', () => {
  it('renders with default and custom props', () => {
    const { rerender, toJSON } = render(<TempoAssistantIcon />);
    expect(toJSON()).toBeTruthy();
    rerender(<TempoAssistantIcon color="#15352B" size={30} />);
    expect(toJSON()).toBeTruthy();
  });
});
