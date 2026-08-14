import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AppState } from 'react-native';

import { RNAppStateProvider } from '../../../../src/infrastructure/appState/RNAppStateProvider';

describe('RNAppStateProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forwards AppState change events to the listener', () => {
    const remove = jest.fn();
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove } as unknown as ReturnType<typeof AppState.addEventListener>);

    const provider = new RNAppStateProvider();
    const listener = jest.fn();
    provider.subscribe(listener);

    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    const handler = addEventListener.mock.calls[0][1] as (status: string) => void;

    handler('background');
    expect(listener).toHaveBeenCalledWith('background');

    handler('active');
    expect(listener).toHaveBeenCalledWith('active');
  });

  it('removes the underlying subscription when the returned unsubscribe is called', () => {
    const remove = jest.fn();
    jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove } as unknown as ReturnType<typeof AppState.addEventListener>);

    const provider = new RNAppStateProvider();
    const unsubscribe = provider.subscribe(jest.fn());

    expect(remove).not.toHaveBeenCalled();
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
