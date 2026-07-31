import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { AssistantChatSheet } from '@/features/assistant/components/AssistantChatSheet';

describe('AssistantChatSheet', () => {
  it('shows empty state and closes', () => {
    const onClose = jest.fn();
    render(
      <AssistantChatSheet
        messages={[]}
        onAction={jest.fn()}
        onClose={onClose}
        onVoiceEnd={jest.fn()}
        visible
      />,
    );
    expect(screen.getByText('等你说第一句话')).toBeTruthy();
    fireEvent.press(screen.getAllByLabelText('关闭语音助手')[0]!);
    expect(onClose).toHaveBeenCalled();
  });

  it('renders user, draft and assistant messages', () => {
    const onAction = jest.fn();
    render(
      <AssistantChatSheet
        visible
        onAction={onAction}
        onClose={jest.fn()}
        onVoiceEnd={jest.fn()}
        messages={[
          { id: 'u1', role: 'user', createdAt: 1, text: '明天下午开会' },
          {
            id: 'd1',
            role: 'assistant',
            createdAt: 2,
            draft: { title: '开会', whenLabel: '明天 15:00', state: 'pending' },
            actions: [{ id: 'ok', kind: 'confirm', label: '加入' }],
          },
          { id: 'a1', role: 'assistant', createdAt: 3, text: '已记下' },
        ]}
      />,
    );
    expect(screen.getByText('明天下午开会')).toBeTruthy();
    expect(screen.getByText('开会')).toBeTruthy();
    expect(screen.getByText('已记下')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('加入'));
    expect(onAction).toHaveBeenCalledWith('d1', { id: 'ok', kind: 'confirm', label: '加入' });
  });

  it('hides when not visible', () => {
    render(
      <AssistantChatSheet
        messages={[]}
        onAction={jest.fn()}
        onClose={jest.fn()}
        onVoiceEnd={jest.fn()}
        visible={false}
      />,
    );
    expect(screen.queryByText('语音助手')).toBeNull();
  });

  it('shows a processing state after recording is released', () => {
    render(
      <AssistantChatSheet
        isProcessing
        messages={[]}
        onAction={jest.fn()}
        onClose={jest.fn()}
        onVoiceEnd={jest.fn()}
        visible
      />,
    );
    expect(screen.getByText('正在整理录音…')).toBeTruthy();
  });
});
