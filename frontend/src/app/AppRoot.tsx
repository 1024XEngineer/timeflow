import { accessAuth } from '../api/auth';
import { LoginScreen } from '../screens/LoginScreen';
import { AppProviders } from './AppProviders';

export function AppRoot() {
  return (
    <AppProviders>
      <LoginScreen authAccess={accessAuth} />
    </AppProviders>
  );
}
