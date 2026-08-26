# Android Adaptive Layout Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four confirmed Android adaptive-layout defects with small, screen-local changes that work across phone widths, font scales, display cutouts, and gesture navigation.

**Architecture:** Keep the existing absolute voice overlay and page hierarchy. Move safe-area and voice-bar reservations from scroll content into fixed viewport boundaries, and make the schedule header choose a stacked layout from logical width and font scale. Give the permission list an explicit flex viewport and make its footer safe-area aware.

**Tech Stack:** React 19.2.3, React Native 0.86, Expo 57, `react-native-safe-area-context` 5.7, Jest 29, Testing Library React Native 13.

## Global Constraints

- Do not change voice state machines, permission rules, navigation, copy, or backend behavior.
- Do not add device-model, physical-resolution, status-bar-pixel, or OEM-specific layout branches.
- Support Android phone widths from 320 dp upward and font scales 1.0, 1.3, and 1.5.
- Keep the existing iOS automatic scroll inset behavior without adding a second top inset.
- Preserve the user's unrelated changes in `backend/src/timeflow/intelligence/realtime/agent.py`, `docker-compose.yml`, `.codex-artifacts/`, `.playwright-cli/`, and `.superpowers/`.
- Make one minimal implementation change at a time and add only task-owned files to each commit.

---

## File Map

- Modify `frontend/src/shared/ui/floatingVoiceBarLayout.ts`: rename the shared bottom reservation to describe that it belongs to the viewport.
- Modify `frontend/src/features/schedule/presentation/ScheduleCalendarScreen.tsx`: consume fixed top/bottom viewport insets and select stacked header styles.
- Modify `frontend/tests/unit/features/schedule/presentation/ScheduleCalendarScreen.test.tsx`: prove viewport inset placement and responsive-header decisions.
- Modify `frontend/src/features/reminder/presentation/PermissionOnboardingScreen.tsx`: add safe-area-aware fixed boundaries and an explicitly flexible scroller.
- Modify `frontend/tests/unit/features/reminder/presentation/PermissionOnboardingScreen.test.tsx`: prove top/bottom inset placement and scroll/footer separation.

No new production file or dependency is needed.

### Task 1: Keep the calendar inside fixed safe regions

**Files:**
- Modify: `frontend/src/shared/ui/floatingVoiceBarLayout.ts`
- Modify: `frontend/src/features/schedule/presentation/ScheduleCalendarScreen.tsx`
- Test: `frontend/tests/unit/features/schedule/presentation/ScheduleCalendarScreen.test.tsx`

**Interfaces:**
- Consumes: `useSafeAreaInsets(): { top: number; bottom: number; ... }` and `useWindowDimensions(): { width: number; fontScale: number; ... }`.
- Produces: `floatingVoiceViewportBottomInset(bottomInset: number): number` and `shouldStackScheduleHeader(width: number, fontScale: number): boolean`.

- [ ] **Step 1: Replace the current assertions with failing viewport-boundary tests**

In `ScheduleCalendarScreen.test.tsx`, import `ViewStyle` only if TypeScript needs it, then update the first three layout tests so they flatten the correct style target:

```tsx
expect(
  StyleSheet.flatten(screen.getByTestId('schedule-calendar-scroll').props.style),
).toMatchObject({ marginBottom: 118 });
expect(
  StyleSheet.flatten(
    screen.getByTestId('schedule-calendar-scroll').props.contentContainerStyle,
  ),
).toMatchObject({ paddingBottom: 24 });

expect(
  StyleSheet.flatten(screen.getByTestId('schedule-calendar-screen').props.style),
).toMatchObject({ paddingTop: 24 });
expect(
  StyleSheet.flatten(
    screen.getByTestId('schedule-calendar-scroll').props.contentContainerStyle,
  ).paddingTop,
).toBeUndefined();
expect(screen.getByTestId('schedule-calendar-scroll').props.contentInsetAdjustmentBehavior).toBe(
  'never',
);

expect(
  StyleSheet.flatten(screen.getByTestId('schedule-calendar-screen').props.style),
).toMatchObject({ paddingTop: 0 });
expect(screen.getByTestId('schedule-calendar-scroll').props.contentInsetAdjustmentBehavior).toBe(
  'automatic',
);
```

Change the responsive-header test import to include `shouldStackScheduleHeader`, then add exact matrix assertions:

```tsx
expect(shouldStackScheduleHeader(320, 1)).toBe(true);
expect(shouldStackScheduleHeader(360, 1)).toBe(true);
expect(shouldStackScheduleHeader(393, 1)).toBe(true);
expect(shouldStackScheduleHeader(430, 1)).toBe(false);
expect(shouldStackScheduleHeader(430, 1.3)).toBe(true);
expect(shouldStackScheduleHeader(430, 1.5)).toBe(true);
```

Keep the existing assertions that the date has no `numberOfLines` limit and the username uses one-line tail ellipsis.
Because the title style becomes an array, flatten it before asserting the unchanged base contract:

```tsx
expect(StyleSheet.flatten(selectedDate.props.style)).toMatchObject({
  flex: 1,
  flexShrink: 1,
  minWidth: 0,
});
```

- [ ] **Step 2: Run the focused schedule test and confirm RED**

Run from `frontend/`:

```bash
npm run test:jest -- --runTestsByPath tests/unit/features/schedule/presentation/ScheduleCalendarScreen.test.tsx
```

Expected: FAIL because `schedule-calendar-screen`, `floatingVoiceViewportBottomInset`, and `shouldStackScheduleHeader` do not exist and the bottom/top insets are still on `contentContainerStyle`.

- [ ] **Step 3: Rename the shared voice viewport reservation**

Replace `floatingVoiceContentBottomInset` in `floatingVoiceBarLayout.ts` with:

```ts
export function floatingVoiceViewportBottomInset(bottomInset: number): number {
  return floatingVoiceBarBottomOffset(bottomInset) + FLOATING_VOICE_BAR_HEIGHT + spacing.md;
}
```

Do not change `FLOATING_VOICE_BAR_HEIGHT` or `floatingVoiceBarBottomOffset`; the overlay must keep its current physical position.

- [ ] **Step 4: Move safe-area reservations onto fixed calendar boundaries**

In `ScheduleCalendarScreen.tsx`, import `useWindowDimensions` and the renamed helper:

```tsx
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { floatingVoiceViewportBottomInset } from '../../../shared/ui/floatingVoiceBarLayout';
```

Add the responsive decision beside the inset calculation:

```tsx
const { fontScale, width } = useWindowDimensions();
const topSafeAreaPadding = Platform.OS === 'android' ? insets.top : 0;
const stackHeader = shouldStackScheduleHeader(width, fontScale);
```

Export this pure function directly above `occurrenceKey`:

```ts
export function shouldStackScheduleHeader(width: number, fontScale: number): boolean {
  const effectiveWidth = width / Math.max(fontScale, 1);
  return effectiveWidth < 400;
}
```

Move insets out of the scroll content and make the platform adjustment explicit:

```tsx
<View
  style={[styles.screen, { paddingTop: topSafeAreaPadding }]}
  testID="schedule-calendar-screen"
>
  <ScrollView
    contentContainerStyle={styles.scrollContent}
    contentInsetAdjustmentBehavior={Platform.OS === 'ios' ? 'automatic' : 'never'}
    showsVerticalScrollIndicator={false}
    style={{ marginBottom: floatingVoiceViewportBottomInset(insets.bottom) }}
    testID="schedule-calendar-scroll"
  >
```

Apply stacked variants without changing the normal layout:

```tsx
<View style={[styles.headerTop, stackHeader && styles.headerTopStacked]}>
  <Text
    testID="schedule-selected-date"
    style={[styles.title, stackHeader && styles.titleStacked]}
  >
    {selectedLabel}
  </Text>
  <View
    style={[styles.accountActions, stackHeader && styles.accountActionsStacked]}
    testID="schedule-account-actions"
  >
```

Add only these styles:

```ts
accountActionsStacked: {
  alignSelf: 'flex-end',
  flexShrink: 0,
  marginLeft: 0,
},
headerTopStacked: {
  alignItems: 'stretch',
  flexDirection: 'column',
  gap: spacing.sm,
},
titleStacked: {
  flex: 0,
  width: '100%',
},
```

Leave `styles.scrollContent` with its existing product padding (`paddingBottom: spacing.lg`) so the last card has breathing room inside the now-unobscured viewport.

- [ ] **Step 5: Run the focused schedule test and confirm GREEN**

Run:

```bash
npm run test:jest -- --runTestsByPath tests/unit/features/schedule/presentation/ScheduleCalendarScreen.test.tsx
```

Expected: PASS with all existing data-refresh, details, account, and layout tests passing.

- [ ] **Step 6: Commit only the schedule layout change**

Run from the repository root:

```bash
git add frontend/src/shared/ui/floatingVoiceBarLayout.ts frontend/src/features/schedule/presentation/ScheduleCalendarScreen.tsx frontend/tests/unit/features/schedule/presentation/ScheduleCalendarScreen.test.tsx
git commit -m "fix(schedule): keep content outside floating controls"
```

Expected: one commit containing only the three listed files.

### Task 2: Keep the permission list between safe fixed boundaries

**Files:**
- Modify: `frontend/src/features/reminder/presentation/PermissionOnboardingScreen.tsx`
- Test: `frontend/tests/unit/features/reminder/presentation/PermissionOnboardingScreen.test.tsx`

**Interfaces:**
- Consumes: `useSafeAreaInsets()` and existing `spacing` tokens.
- Produces: no new public API; adds stable test IDs `permission-onboarding-screen`, `permission-list-scroll`, and `permission-footer`.

- [ ] **Step 1: Add a failing safe-area and scroll separation test**

At the top of `PermissionOnboardingScreen.test.tsx`, add `StyleSheet` and a controllable safe-area mock:

```tsx
import { StyleSheet } from 'react-native';

let mockBottomInset = 0;
let mockTopInset = 0;

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: mockBottomInset, left: 0, right: 0, top: mockTopInset }),
}));
```

Reset both values in `afterEach`, then add:

```tsx
it('keeps the list between the display cutout and gesture navigation areas', async () => {
  mockTopInset = 24;
  mockBottomInset = 20;
  const device = createDevice(deniedPermissions());

  render(
    <PermissionOnboardingScreen
      device={device}
      onContinue={jest.fn()}
      onPermissionsUpdated={jest.fn()}
    />,
  );
  await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

  expect(
    StyleSheet.flatten(screen.getByTestId('permission-onboarding-screen').props.style),
  ).toMatchObject({ paddingTop: 24 });
  expect(StyleSheet.flatten(screen.getByTestId('permission-list-scroll').props.style)).toMatchObject(
    { flex: 1 },
  );
  expect(StyleSheet.flatten(screen.getByTestId('permission-footer').props.style)).toMatchObject({
    paddingBottom: 36,
  });
  expect(
    StyleSheet.flatten(screen.getByTestId('permission-copy-location_background').props.style),
  ).toMatchObject({ flex: 1, minWidth: 0 });
  expect(
    StyleSheet.flatten(screen.getByTestId('permission-action-location_background').props.style),
  ).toMatchObject({ flexShrink: 0, minWidth: 84 });
  expect(
    StyleSheet.flatten(screen.getByText('后台定位（始终允许）').props.style),
  ).toMatchObject({ flexShrink: 1 });
});
```

- [ ] **Step 2: Run the focused permission test and confirm RED**

Run from `frontend/`:

```bash
npm run test:jest -- --runTestsByPath tests/unit/features/reminder/presentation/PermissionOnboardingScreen.test.tsx
```

Expected: FAIL because the safe-area hook and three test IDs are not yet used.

- [ ] **Step 3: Add safe-area-aware fixed boundaries with no workflow changes**

In `PermissionOnboardingScreen.tsx`, import and read the insets:

```tsx
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const insets = useSafeAreaInsets();
```

Update the root opening tag from `<View style={styles.screen}>` to:

```tsx
<View
  style={[styles.screen, { paddingTop: insets.top }]}
  testID="permission-onboarding-screen"
>
```

Update the scroll opening tag from `<ScrollView contentContainerStyle={styles.content}>` to:

```tsx
  <ScrollView
    contentContainerStyle={styles.content}
    style={styles.scroll}
    testID="permission-list-scroll"
  >
```

Update the footer opening tag from `<View style={styles.footer}>` to:

```tsx
  <View
    style={[
      styles.footer,
      { paddingBottom: Math.max(spacing.lg, insets.bottom + spacing.md) },
    ]}
    testID="permission-footer"
  >
```

The existing closing tags, title, OEM guidance, footer hint, continue button, and permission event handlers stay byte-for-byte unchanged.

Add a stable test ID to the existing permission copy container:

```tsx
<View style={styles.rowText} testID={`permission-copy-${row.permission}`}>
```

Add the scroll style and three shrink constraints; do not modify permission row business rendering:

```ts
actionButton: {
  backgroundColor: colors.text,
  borderRadius: 8,
  flexShrink: 0,
  minWidth: 84,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.sm,
},
rowText: {
  flex: 1,
  gap: spacing.xs,
  minWidth: 0,
},
rowTitle: {
  color: colors.text,
  flexShrink: 1,
  fontSize: 15,
  fontWeight: '700',
},
scroll: {
  flex: 1,
},
```

- [ ] **Step 4: Run the focused permission test and confirm GREEN**

Run:

```bash
npm run test:jest -- --runTestsByPath tests/unit/features/reminder/presentation/PermissionOnboardingScreen.test.tsx
```

Expected: PASS with the new layout test and all permission/OEM interaction tests passing.

- [ ] **Step 5: Commit only the permission layout change**

Run from the repository root:

```bash
git add frontend/src/features/reminder/presentation/PermissionOnboardingScreen.tsx frontend/tests/unit/features/reminder/presentation/PermissionOnboardingScreen.test.tsx
git commit -m "fix(reminder): respect permission screen safe areas"
```

Expected: one commit containing only the two listed files.

### Task 3: Verify the minimal fix and regress it on the USB phone

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Consumes: the two preceding commits and Android device serial `efae9412`.
- Produces: passing frontend checks plus visual/device-boundary evidence.

- [ ] **Step 1: Run formatting, lint, and type checks**

Run from `frontend/`:

```bash
npm run format:check
npm run lint
npm run typecheck
```

Expected: all three commands exit 0. If formatting alone fails for the touched files, run Prettier only on those five touched files, then repeat the checks.

- [ ] **Step 2: Run the complete frontend test suite**

Run:

```bash
npm test
```

Expected: Vitest and Jest both exit 0 with no regression in schedule, reminder, or assistant behavior.

- [ ] **Step 3: Build, install, and launch the current source on the USB phone**

Confirm the serial, then run from `frontend/`:

```bash
adb devices -l
npx expo run:android --device efae9412
```

Expected: the Android build succeeds, `com.anonymous.timeflow` installs, and `MainActivity` launches on `efae9412`.

- [ ] **Step 4: Verify default-scale component boundaries**

Record the original font scale, capture the window hierarchy and screenshot, and verify:

```bash
adb -s efae9412 shell settings get system font_scale
adb -s efae9412 shell uiautomator dump /sdcard/timeflow-layout.xml
adb -s efae9412 pull /sdcard/timeflow-layout.xml .codex-artifacts/timeflow-layout-default.xml
adb -s efae9412 exec-out screencap -p
```

Expected visual result: the full date is visible; schedule rows end above the base voice bar; scrolling never places calendar content in the 138 px top inset; the permission footer is above the 56 px gesture area and the last permission row is reachable.

- [ ] **Step 5: Verify enlarged text and restore the original setting**

Use PowerShell `try/finally`: record the current value, temporarily set 1.5, relaunch, inspect both screens, then restore the exact recorded value even if inspection fails.

```powershell
$timeflowOriginalFontScale = (adb -s efae9412 shell settings get system font_scale).Trim()
try {
  adb -s efae9412 shell settings put system font_scale 1.5
  adb -s efae9412 shell am force-stop com.anonymous.timeflow
  adb -s efae9412 shell monkey -p com.anonymous.timeflow -c android.intent.category.LAUNCHER 1
  adb -s efae9412 shell uiautomator dump /sdcard/timeflow-layout-font-1-5.xml
  adb -s efae9412 pull /sdcard/timeflow-layout-font-1-5.xml .codex-artifacts/timeflow-layout-font-1-5.xml
  cmd /c "adb -s efae9412 exec-out screencap -p > .codex-artifacts\timeflow-layout-font-1-5.png"
} finally {
  adb -s efae9412 shell settings put system font_scale $timeflowOriginalFontScale
}
adb -s efae9412 shell settings get system font_scale
```

Expected at 1.5: the schedule account controls stack below the complete date and all permission content remains reachable by scrolling. Expected after restoration: `settings get system font_scale` returns the exact original value recorded in Step 4, not an assumed value.

- [ ] **Step 6: Confirm the worktree contains no unintended staged changes**

Run from the repository root:

```bash
git status --short
git diff --check
```

Expected: only the user's pre-existing unrelated modifications/untracked paths remain; there are no new unstaged layout edits and no whitespace errors.
