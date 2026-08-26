import { AppState, type AppStateStatus } from 'react-native';

import type { AppLifecycleStatus, AppStateProvider } from './AppStateProvider';

function boundStatus(state: AppStateStatus): AppLifecycleStatus {
  if (state === 'active' || state === 'background' || state === 'inactive') {
    return state;
  }
  return 'inactive';
}

export class RNAppStateProvider implements AppStateProvider {
  current(): AppLifecycleStatus {
    return boundStatus(AppState.currentState);
  }

  subscribe(listener: (status: AppLifecycleStatus) => void): () => void {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) =>
      listener(boundStatus(next)),
    );
    return () => subscription.remove();
  }
}
