import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockNativeStart = jest.fn(async () => undefined);
const mockNativeStop = jest.fn(async () => undefined);
const mockNativeCancel = jest.fn(async () => undefined);
const mockCheck = jest.fn(async () => true);
const mockRequest = jest.fn(async () => 'granted');
const mockListeners = new Map<string, (event: unknown) => void>();
const mockRemove = jest.fn();

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: 'android.permission.RECORD_AUDIO' },
    RESULTS: { GRANTED: 'granted' },
    check: (...args: unknown[]) => (mockCheck as (...values: unknown[]) => unknown)(...args),
    request: (...args: unknown[]) => (mockRequest as (...values: unknown[]) => unknown)(...args),
  },
  NativeModules: {
    TimeflowVoiceRecorder: {
      start: (...args: unknown[]) =>
        (mockNativeStart as (...values: unknown[]) => unknown)(...args),
      stop: (...args: unknown[]) => (mockNativeStop as (...values: unknown[]) => unknown)(...args),
      cancel: (...args: unknown[]) =>
        (mockNativeCancel as (...values: unknown[]) => unknown)(...args),
      addListener: jest.fn(),
      removeListeners: jest.fn(),
    },
  },
  NativeEventEmitter: class {
    addListener(eventName: string, listener: (event: unknown) => void) {
      mockListeners.set(eventName, listener);
      return { remove: mockRemove };
    }
  },
}));

import { Platform } from 'react-native';

import {
  AndroidPcmVoiceRecorder,
  BrowserPcmVoiceRecorder,
  VoiceRecordingUnavailableError,
  createVoiceRecorder,
} from '@/infrastructure/audio/VoiceRecorder';

describe('AndroidPcmVoiceRecorder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListeners.clear();
    mockCheck.mockResolvedValue(true);
    mockRequest.mockResolvedValue('granted');
    (Platform as { OS: string }).OS = 'android';
  });

  it('requests permission when needed and starts the native recorder', async () => {
    mockCheck.mockResolvedValueOnce(false);
    const recorder = new AndroidPcmVoiceRecorder();

    await recorder.start(() => undefined);

    expect(mockRequest).toHaveBeenCalledWith(
      'android.permission.RECORD_AUDIO',
      expect.objectContaining({ title: '麦克风权限' }),
    );
    expect(mockNativeStart).toHaveBeenCalledTimes(1);
    await recorder.cancel();
  });

  it('decodes native Base64 PCM chunks into ArrayBuffer values', async () => {
    const recorder = new AndroidPcmVoiceRecorder();
    const onChunk = jest.fn<(chunk: ArrayBuffer) => void>();
    await recorder.start(onChunk);

    mockListeners.get('TimeflowVoiceRecorderChunk')?.('AQD+/w==');

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(Array.from(new Uint8Array(onChunk.mock.calls[0]![0] as ArrayBuffer))).toEqual([
      1, 0, 254, 255,
    ]);
    await recorder.stop();
    expect(mockNativeStop).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledTimes(2);
  });

  it('rejects denied microphone permission without starting native capture', async () => {
    mockCheck.mockResolvedValueOnce(false);
    mockRequest.mockResolvedValueOnce('denied');
    const recorder = new AndroidPcmVoiceRecorder();

    await expect(recorder.start(() => undefined)).rejects.toThrow('麦克风权限未授予');
    expect(mockNativeStart).not.toHaveBeenCalled();
  });

  it('surfaces asynchronous native failures when recording stops', async () => {
    const recorder = new AndroidPcmVoiceRecorder();
    await recorder.start(() => undefined);
    mockListeners.get('TimeflowVoiceRecorderError')?.({ message: 'audio device lost' });

    await expect(recorder.stop()).rejects.toThrow('audio device lost');
  });

  it('selects the platform-specific implementation', () => {
    expect(createVoiceRecorder()).toBeInstanceOf(AndroidPcmVoiceRecorder);
    (Platform as { OS: string }).OS = 'web';
    expect(createVoiceRecorder()).toBeInstanceOf(BrowserPcmVoiceRecorder);
  });

  it('reports a missing native module clearly', async () => {
    const recorder = new AndroidPcmVoiceRecorder(null);
    await expect(recorder.start(() => undefined)).rejects.toBeInstanceOf(
      VoiceRecordingUnavailableError,
    );
  });
});
