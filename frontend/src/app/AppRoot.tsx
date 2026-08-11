import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../shared/ui/theme';
import { AppProviders } from './AppProviders';

export function AppRoot() {
  return (
    <AppProviders>
      <View style={styles.container}>
        <Text style={styles.title}>Timeflow</Text>
        <StatusBar style="auto" />
      </View>
    </AppProviders>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    color: colors.text,
    fontSize: 24,
    padding: spacing.md,
  },
});
