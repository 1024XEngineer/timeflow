import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';

jest.mock('@/app/AppShell', () => {
  const { Text } = require('react-native');
  return { AppShell: () => <Text>connected-app-shell</Text> };
});

import { AppRoot } from '@/app/AppRoot';

describe('AppRoot', () => {
  it('mounts the connected application shell', () => {
    render(<AppRoot />);
    expect(screen.getByText('connected-app-shell')).toBeTruthy();
  });
});
