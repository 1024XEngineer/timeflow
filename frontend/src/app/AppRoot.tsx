import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppShell } from '@/app/AppShell';
import type { LocationProvider } from '@/app/integrations/useLocationReporting';
import type { VoiceRecorder } from '@/features/assistant';

import { appRootStyles as styles } from './AppRoot.styles';

/** 应用根布局：单屏组合，不做路由。 */
export function AppRoot({
  locationProvider,
  voiceRecorder,
}: {
  locationProvider?: LocationProvider;
  voiceRecorder?: VoiceRecorder;
} = {}) {
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.appFrame}>
        <AppShell locationProvider={locationProvider} voiceRecorder={voiceRecorder} />
      </View>
    </SafeAreaView>
  );
}
