import { CalendarClock, Check, CheckCircle2 } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { colors } from '@/shared/theme';

import type { AssistantDraft, AssistantMessageAction } from '../types';
import { assistantDraftCardStyles as styles } from './AssistantDraftCard.styles';

const CHIP_LABEL = {
  pending: '待确认',
  added: '已加入日程',
  dismissed: '已忽略',
} as const;

/** 助手把语音解析成的日程草稿：先看清内容，再决定是否加入日程。 */
export function AssistantDraftCard({
  actions,
  draft,
  onAction,
}: {
  actions?: AssistantMessageAction[];
  draft: AssistantDraft;
  onAction: (action: AssistantMessageAction) => void;
}) {
  const state = draft.state ?? 'pending';
  const resolved = state !== 'pending';
  const showActions = state === 'pending' && actions && actions.length > 0;

  return (
    <View style={[styles.card, resolved && styles.cardResolved]}>
      <View style={styles.head}>
        <View style={[styles.icon, resolved && styles.iconResolved]}>
          <CalendarClock color={resolved ? colors.sub : colors.deep} size={17} strokeWidth={2.1} />
        </View>
        <View style={styles.copy}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>{draft.title}</Text>
            <View
              style={[
                styles.chip,
                state === 'added' && styles.chipAdded,
                state === 'dismissed' && styles.chipDismissed,
              ]}
            >
              {state === 'added' ? (
                <CheckCircle2 color="#63866E" size={10} strokeWidth={2.4} />
              ) : null}
              <Text
                style={[
                  styles.chipText,
                  state === 'added' && styles.chipTextAdded,
                  state === 'dismissed' && styles.chipTextDismissed,
                ]}
              >
                {CHIP_LABEL[state]}
              </Text>
            </View>
          </View>
          <Text style={styles.when}>{draft.whenLabel}</Text>
          {draft.metaLabel ? <Text style={styles.meta}>{draft.metaLabel}</Text> : null}
          {draft.clarificationLabel ? (
            <Text accessibilityRole="text" style={styles.clarification}>
              {draft.clarificationLabel}
            </Text>
          ) : null}
        </View>
      </View>
      {showActions ? (
        <View style={styles.actions}>
          {actions.map((action) => {
            const confirm = action.kind === 'confirm';
            return (
              <Pressable
                key={action.id}
                accessibilityLabel={action.label}
                accessibilityRole="button"
                onPress={() => onAction(action)}
                style={[styles.action, confirm ? styles.actionConfirm : styles.actionDismiss]}
              >
                {confirm ? <Check color={colors.deep} size={14} strokeWidth={2.4} /> : null}
                <Text style={confirm ? styles.actionConfirmText : styles.actionDismissText}>
                  {action.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={styles.bottomPad} />
      )}
    </View>
  );
}
