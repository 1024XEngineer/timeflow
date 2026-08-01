import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/schedule/location/AddressEditorSheet', () => ({
  AddressEditorSheet: ({
    visible,
    onSave,
    onClose,
  }: {
    visible: boolean;
    onSave: (location: {
      address: string;
      latitude: number;
      longitude: number;
      name?: string;
    }) => void;
    onClose: () => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    if (!visible) return null;
    return (
      <>
        <Pressable
          accessibilityLabel="mock-save-location"
          onPress={() =>
            onSave({ address: '新地址', latitude: 31.1, longitude: 121.1, name: '新地点' })
          }
        >
          <Text>mock-save</Text>
        </Pressable>
        <Pressable accessibilityLabel="mock-close-editor" onPress={onClose}>
          <Text>mock-close</Text>
        </Pressable>
      </>
    );
  },
}));

import { LocationPickerSheet } from '@/features/schedule/location/LocationPickerSheet';

const office = {
  id: 'loc_1',
  address: '南京东路1号',
  latitude: 31.2,
  longitude: 121.5,
  name: '办公室',
};

describe('LocationPickerSheet', () => {
  it('shows empty state', () => {
    render(
      <LocationPickerSheet
        visible
        locations={[]}
        onClose={jest.fn()}
        onSelect={jest.fn()}
        onUpsertLocation={jest.fn()}
      />,
    );
    expect(screen.getByText('还没有常用地点')).toBeTruthy();
  });

  it('selects a location and closes', () => {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    render(
      <LocationPickerSheet
        visible
        locations={[office]}
        selectedId="loc_1"
        onClose={onClose}
        onSelect={onSelect}
        onUpsertLocation={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByLabelText('选择地点 办公室'));
    expect(onSelect).toHaveBeenCalledWith(office);
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the editor and upserts a new location', () => {
    const onUpsert = jest.fn();
    const onSelect = jest.fn();
    const onClose = jest.fn();
    render(
      <LocationPickerSheet
        visible
        locations={[]}
        onClose={onClose}
        onSelect={onSelect}
        onUpsertLocation={onUpsert}
      />,
    );
    fireEvent.press(screen.getByLabelText('添加地点'));
    fireEvent.press(screen.getByLabelText('mock-save-location'));
    expect(onUpsert).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
