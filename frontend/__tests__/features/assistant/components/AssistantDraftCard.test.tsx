import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import type { AssistantDraft } from '@/features/assistant/types';
import { AssistantDraftCard } from '@/features/assistant/components/AssistantDraftCard';

const draft = (overrides: Partial<AssistantDraft> = {}): AssistantDraft => ({
  title: '下午评审',
  whenLabel: '今天 15:00',
  state: 'pending',
  ...overrides,
});

describe('AssistantDraftCard', () => {
  it('shows actions while pending', () => {
    const onAction = jest.fn();
    render(
      <AssistantDraftCard
        draft={draft({ metaLabel: '会议室 A' })}
        actions={[
          { id: 'ok', kind: 'confirm', label: '加入' },
          { id: 'no', kind: 'dismiss', label: '忽略' },
        ]}
        onAction={onAction}
      />,
    );
    expect(screen.getByText('待确认')).toBeTruthy();
    expect(screen.getByText('会议室 A')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('加入'));
    expect(onAction).toHaveBeenCalledWith({ id: 'ok', kind: 'confirm', label: '加入' });
  });

  it('hides actions after the draft is resolved', () => {
    render(
      <AssistantDraftCard
        draft={draft({ state: 'added' })}
        actions={[{ id: 'ok', kind: 'confirm', label: '加入' }]}
        onAction={jest.fn()}
      />,
    );
    expect(screen.getByText('已加入日程')).toBeTruthy();
    expect(screen.queryByLabelText('加入')).toBeNull();
  });

  it('renders dismissed chip', () => {
    render(<AssistantDraftCard draft={draft({ state: 'dismissed' })} onAction={jest.fn()} />);
    expect(screen.getByText('已忽略')).toBeTruthy();
  });
});
