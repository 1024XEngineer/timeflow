import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetInfoAsync = jest.fn(async () => ({ exists: true }));
const mockReadAsStringAsync = jest.fn(async () => ' device_existing ');
const mockWriteAsStringAsync = jest.fn(async () => undefined);
const mockFileSystem = {
  documentDirectory: 'file:///documents/',
  getInfoAsync: mockGetInfoAsync,
  readAsStringAsync: mockReadAsStringAsync,
  writeAsStringAsync: mockWriteAsStringAsync,
};

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

jest.mock('expo', () => ({
  requireOptionalNativeModule: jest.fn(() => mockFileSystem),
}));

import { createDeviceIdStore } from '@/infrastructure/storage/deviceIdStore';

describe('native deviceIdStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetInfoAsync.mockResolvedValue({ exists: true });
    mockReadAsStringAsync.mockResolvedValue(' device_existing ');
  });

  it('passes the options arguments required by Expo SDK 57 native methods', async () => {
    const store = await createDeviceIdStore();

    await expect(store.get()).resolves.toBe('device_existing');
    await store.set('device_updated');

    const path = 'file:///documents/.timeflow-device-id';
    expect(mockGetInfoAsync).toHaveBeenCalledWith(path, {});
    expect(mockReadAsStringAsync).toHaveBeenCalledWith(path, {});
    expect(mockWriteAsStringAsync).toHaveBeenCalledWith(path, 'device_updated', {});
  });
});
