import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { MapPickerOverlay } from '@/features/schedule/location/MapPicker/Overlay';

async function flushDebouncedSearch() {
  await act(async () => {
    jest.advanceTimersByTime(320);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('MapPickerOverlay', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const base = {
    mapError: null as string | null,
    mapReady: true,
    locating: false,
    locationError: null as string | null,
    onCancel: jest.fn(),
    onLocate: jest.fn(),
    onConfirm: jest.fn(),
    onSearch: jest.fn(async () => [
      { address: '外滩 · 中山东一路', latitude: 31.24, longitude: 121.49 },
    ]),
    onSelectSearchResult: jest.fn(),
    selection: {
      address: '南京东路',
      latitude: 31.23,
      longitude: 121.48,
    },
  };

  it('debounces search and lists results', async () => {
    render(<MapPickerOverlay {...base} />);
    fireEvent.changeText(screen.getByLabelText('搜索地点'), '外滩');
    await flushDebouncedSearch();
    expect(base.onSearch).toHaveBeenCalledWith('外滩');
    expect(screen.getByText('外滩 · 中山东一路')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('选择 外滩 · 中山东一路'));
    expect(base.onSelectSearchResult).toHaveBeenCalled();
  });

  it('confirms and cancels', () => {
    render(<MapPickerOverlay {...base} />);
    fireEvent.press(screen.getByLabelText('确认选中的地址'));
    expect(base.onConfirm).toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('退出地图选点'));
    expect(base.onCancel).toHaveBeenCalled();
  });

  it('shows map errors and locating state', () => {
    render(
      <MapPickerOverlay
        {...base}
        mapError="地图加载失败"
        locating
        locationError="定位失败"
        selection={null}
      />,
    );
    expect(screen.getByText('地图加载失败')).toBeTruthy();
    expect(screen.getByText('定位失败')).toBeTruthy();
    expect(screen.getByText('正在获取当前位置...')).toBeTruthy();
  });

  it('surfaces search failures', async () => {
    const onSearch = jest.fn(async () => {
      throw new Error('qps');
    });
    render(<MapPickerOverlay {...base} onSearch={onSearch} />);
    fireEvent.changeText(screen.getByLabelText('搜索地点'), '失败');
    await flushDebouncedSearch();
    expect(screen.getByText('搜索暂时不可用，请直接在地图上选点')).toBeTruthy();
  });

  it('shows empty search results', async () => {
    const onSearch = jest.fn(async () => []);
    render(<MapPickerOverlay {...base} onSearch={onSearch} />);
    fireEvent.changeText(screen.getByLabelText('搜索地点'), '空');
    await flushDebouncedSearch();
    expect(screen.getByText('没有找到相关地点')).toBeTruthy();
  });
});
