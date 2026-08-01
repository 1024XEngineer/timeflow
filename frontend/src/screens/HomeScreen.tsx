import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { MapPin } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MapPicker } from '../components/MapPicker';
import type { MapLocation } from '../components/MapPicker.types';
import { colors, radii, spacing } from '../constants/theme';

export function HomeScreen() {
  const [location, setLocation] = useState<MapLocation | null>(null);
  const [pickingLocation, setPickingLocation] = useState(false);

  if (pickingLocation) {
    return (
      <MapPicker
        initialLocation={location}
        onCancel={() => setPickingLocation(false)}
        onConfirm={(nextLocation) => {
          setLocation(nextLocation);
          setPickingLocation(false);
        }}
      />
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Timeflow</Text>
      <Text style={styles.subtitle}>为日程选择提醒地点</Text>
      {location ? (
        <View style={styles.locationSummary}>
          <MapPin color={colors.deep} size={20} strokeWidth={2} />
          <View style={styles.locationCopy}>
            <Text numberOfLines={2} style={styles.locationAddress}>
              {location.address}
            </Text>
            <Text style={styles.locationCoordinates}>
              {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
            </Text>
          </View>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => setPickingLocation(true)}
        style={({ pressed }) => [styles.mapButton, pressed && styles.mapButtonPressed]}
      >
        <MapPin color={colors.deep} size={18} strokeWidth={2.2} />
        <Text style={styles.mapButtonText}>{location ? '重新选择地点' : '打开地图选点'}</Text>
      </Pressable>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.sub,
    fontSize: 15,
    marginBottom: spacing.lg,
    marginTop: spacing.xs,
  },
  locationSummary: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: radii.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
    maxWidth: 420,
    padding: spacing.md,
    width: '100%',
  },
  locationCopy: {
    flex: 1,
  },
  locationAddress: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  locationCoordinates: {
    color: colors.sub,
    fontSize: 12,
    marginTop: spacing.xs,
  },
  mapButton: {
    alignItems: 'center',
    backgroundColor: colors.lime,
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    maxWidth: 420,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    width: '100%',
  },
  mapButtonPressed: {
    opacity: 0.78,
  },
  mapButtonText: {
    color: colors.deep,
    fontSize: 15,
    fontWeight: '700',
  },
});
