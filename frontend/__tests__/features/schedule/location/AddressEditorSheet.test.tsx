import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/schedule/location/MapPicker', () => ({
  MapPicker: () => null,
}));

import { AddressEditorSheet } from '@/features/schedule/location/AddressEditorSheet';

describe('AddressEditorSheet', () => {
  it('requires a map location before save', () => {
    const onSave = jest.fn();
    render(<AddressEditorSheet visible title="添加地点" onClose={jest.fn()} onSave={onSave} />);
    fireEvent.press(screen.getByLabelText('保存地点'));
    expect(screen.getByText('请选择一个地图位置')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves with an optional name', () => {
    const onSave = jest.fn();
    render(
      <AddressEditorSheet
        visible
        title="编辑地点"
        initialLocation={{ address: '南京东路1号', latitude: 31.2, longitude: 121.5 }}
        onClose={jest.fn()}
        onSave={onSave}
      />,
    );
    fireEvent.changeText(screen.getByLabelText('地点名称'), '办公室');
    fireEvent.press(screen.getByLabelText('保存地点'));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '南京东路1号',
        name: '办公室',
      }),
    );
  });
});
