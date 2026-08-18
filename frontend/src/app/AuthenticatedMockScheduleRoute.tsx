import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { MockAssistantApplication } from '../features/assistant/data/MockAssistantApplication';
import { useAuth } from '../features/auth/presentation/AuthProvider';
import { MockScheduleClientService } from '../features/schedule/application/MockScheduleClientService';
import { HomeScreen } from '../screens/HomeScreen';
import { colors } from '../shared/ui/theme';

export function AuthenticatedMockScheduleRoute({
  accountId,
  username,
}: {
  readonly accountId: string;
  readonly username: string;
}) {
  const { signOut } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const scheduleService = useMemo(() => new MockScheduleClientService(), []);
  const pushToTalkApplication = useMemo(() => new MockAssistantApplication(), []);
  const continuousApplication = useMemo(() => new MockAssistantApplication(), []);

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      setIsSigningOut(false);
    }
  }, [isSigningOut, signOut]);

  useEffect(() => {
    return () => {
      pushToTalkApplication.dispose();
      continuousApplication.dispose();
    };
  }, [continuousApplication, pushToTalkApplication]);

  return (
    <View style={styles.route}>
      <HomeScreen
        accountId={accountId}
        continuousApplication={continuousApplication}
        isSigningOut={isSigningOut}
        onSignOut={handleSignOut}
        pushToTalkApplication={pushToTalkApplication}
        scheduleService={scheduleService}
        timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
        username={username}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  route: { backgroundColor: colors.background, flex: 1 },
});
