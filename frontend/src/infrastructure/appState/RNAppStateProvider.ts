import { AppState, type AppStateStatus } from 'react-native';

import type { AppLifecycleStatus, AppStateProvider } from './AppStateProvider';

export class RNAppStateProvider implements AppStateProvider {
  subscribe(listener: (status: AppLifecycleStatus) => void): () => void {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) =>
      listener(next as AppLifecycleStatus),
    );
    return () => subscription.remove();
  }
}
