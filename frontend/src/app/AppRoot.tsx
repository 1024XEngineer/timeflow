import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { VoiceRecorder } from '@/features/assistant';

import { appRootStyles as styles } from './AppRoot.styles';
import { AppShell } from './AppShell';

/** Application root layout for the connected single-screen experience. */
export function AppRoot({ voiceRecorder }: { voiceRecorder?: VoiceRecorder } = {}) {
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.appFrame}>
        <AppShell voiceRecorder={voiceRecorder} />
      </View>
    </SafeAreaView>
  );
}
