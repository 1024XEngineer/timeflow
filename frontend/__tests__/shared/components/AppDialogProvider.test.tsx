import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import { AppDialogProvider, useAppDialog } from '@/shared/components/AppDialogProvider';

function Harness() {
  const { confirm, showNotice } = useAppDialog();
  return (
    <>
      <Pressable
        accessibilityLabel="show-notice"
        onPress={() => void showNotice({ title: '连接不可用', message: '请检查网络' })}
      />
      <Pressable
        accessibilityLabel="show-confirm"
        onPress={() =>
          void confirm({
            title: '删除日程',
            message: '删除后无法恢复',
            confirmLabel: '删除',
            tone: 'danger',
          })
        }
      />
      <Text>content</Text>
    </>
  );
}

describe('AppDialogProvider', () => {
  it('renders notices in the app instead of a native Alert', () => {
    render(
      <AppDialogProvider>
        <Harness />
      </AppDialogProvider>,
    );

    fireEvent.press(screen.getByLabelText('show-notice'));
    expect(screen.getByText('连接不可用')).toBeTruthy();
    expect(screen.getByText('请检查网络')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('知道了'));
    expect(screen.queryByText('连接不可用')).toBeNull();
  });

  it('renders custom destructive confirmations', () => {
    render(
      <AppDialogProvider>
        <Harness />
      </AppDialogProvider>,
    );

    fireEvent.press(screen.getByLabelText('show-confirm'));
    expect(screen.getByText('删除后无法恢复')).toBeTruthy();
    expect(screen.getByLabelText('取消')).toBeTruthy();
    expect(screen.getByLabelText('删除')).toBeTruthy();
  });
});
