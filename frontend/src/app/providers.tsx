import { useMemo, type ReactNode } from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createReminderAlarmAdapter } from '@/app/integrations/reminderAlarmAdapter';
import { OverlayProvider } from '@/app/overlay/OverlayProvider';
import { SessionProvider, useSession } from '@/app/session/SessionProvider';
import { ScheduleProvider } from '@/features/schedule';
import type { DeviceIdStore } from '@/infrastructure/storage/deviceIdStore';
import { AppDialogProvider, useAppDialog } from '@/shared/components/AppDialogProvider';

import { providerStyles as styles } from './providers.styles';

function ScheduleSessionBridge({ children }: { children: ReactNode }) {
  const { client, connectionStatus, userId, sessionEpoch } = useSession();
  const { showNotice } = useAppDialog();
  const alarmAdapter = useMemo(() => createReminderAlarmAdapter(showNotice), [showNotice]);
  return (
    <ScheduleProvider
      alarmAdapter={alarmAdapter}
      client={client}
      connectionStatus={connectionStatus}
      userId={userId}
      sessionEpoch={sessionEpoch}
    >
      {children}
    </ScheduleProvider>
  );
}

export function AppProviders({
  children,
  deviceIdStore,
}: {
  children: ReactNode;
  deviceIdStore?: DeviceIdStore;
}) {
  const { width } = useWindowDimensions();
  const tree = (
    <SessionProvider deviceIdStore={deviceIdStore}>
      <ScheduleSessionBridge>
        <OverlayProvider>{children}</OverlayProvider>
      </ScheduleSessionBridge>
    </SessionProvider>
  );

  if (Platform.OS !== 'web') {
    return (
      <SafeAreaProvider>
        <AppDialogProvider>{tree}</AppDialogProvider>
      </SafeAreaProvider>
    );
  }

  const compact = width < 480;
  return (
    <SafeAreaProvider>
      <AppDialogProvider>
        <View style={[styles.desktopCanvas, compact && styles.compactCanvas]}>
          <View style={[styles.webAppFrame, compact && styles.compactFrame]}>{tree}</View>
        </View>
      </AppDialogProvider>
    </SafeAreaProvider>
  );
}
