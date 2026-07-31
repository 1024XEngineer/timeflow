import { AppRoot } from '@/app/AppRoot';
import { AppProviders } from '@/app/providers';
import { useAlarmPermissionsOnLaunch } from '@/features/reminder';

function Root() {
  useAlarmPermissionsOnLaunch();
  return <AppRoot />;
}

export default function App() {
  return (
    <AppProviders>
      <Root />
    </AppProviders>
  );
}
