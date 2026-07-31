import { useEffect, useRef } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomSheetFrame } from '@/shared/components/BottomSheetFrame';
import { colors } from '@/shared/theme';

import type { AssistantMessage, AssistantMessageAction } from '../types';
import { assistantChatSheetStyles as styles } from './AssistantChatSheet.styles';
import { AssistantDraftCard } from './AssistantDraftCard';
import { TempoAssistantIcon } from './TempoAssistantIcon';
import { VoiceHoldButton } from './VoiceHoldButton';

export function AssistantChatSheet({
  isProcessing = false,
  messages,
  onAction,
  onClose,
  onVoiceCancel,
  onVoiceEnd,
  onVoiceStart,
  visible,
}: {
  isProcessing?: boolean;
  messages: AssistantMessage[];
  onAction: (messageId: string, action: AssistantMessageAction) => void;
  onClose: () => void;
  onVoiceCancel?: () => void;
  onVoiceEnd: () => void;
  onVoiceStart?: () => void;
  visible: boolean;
}) {
  const listRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [messages, visible]);

  return (
    <BottomSheetFrame
      closeAccessibilityLabel="关闭语音助手"
      header={
        <>
          <View style={styles.mark}>
            <TempoAssistantIcon color={colors.lime} size={19} />
          </View>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>语音助手</Text>
            <Text style={styles.subtitle}>说一句话，我整理成日程给你确认</Text>
          </View>
        </>
      }
      headerStyle={styles.header}
      onClose={onClose}
      sheetStyle={styles.sheet}
      visible={visible}
    >
      <ScrollView
        ref={listRef}
        contentContainerStyle={[
          styles.listContent,
          messages.length === 0 && styles.listContentEmpty,
        ]}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        showsVerticalScrollIndicator={false}
        style={styles.list}
      >
        {messages.length === 0 ? (
          <View style={styles.empty}>
            <Text accessibilityLiveRegion="polite" style={styles.emptyTitle}>
              {isProcessing ? '正在整理录音…' : '等你说第一句话'}
            </Text>
            <Text style={styles.emptyHint}>
              {isProcessing
                ? '识别完成后会生成一张待确认的日程草稿'
                : '松开手指后，识别到的内容会整理成日程草稿显示在这里'}
            </Text>
          </View>
        ) : null}
        {messages.map((item) => {
          if (item.role === 'user') {
            return (
              <View key={item.id} style={styles.rowUser}>
                <View style={styles.bubbleUser}>
                  <Text style={styles.bubbleUserText}>{item.text}</Text>
                </View>
              </View>
            );
          }

          if (item.draft) {
            return (
              <View key={item.id} style={styles.draftSlot}>
                <AssistantDraftCard
                  actions={item.actions}
                  draft={item.draft}
                  onAction={(action) => onAction(item.id, action)}
                />
              </View>
            );
          }

          return (
            <View key={item.id} style={styles.rowAssistant}>
              <View style={styles.bubbleAssistant}>
                <Text style={styles.bubbleAssistantText}>{item.text}</Text>
              </View>
            </View>
          );
        })}
        {isProcessing && messages.length > 0 ? (
          <View style={styles.rowAssistant}>
            <View style={styles.bubbleAssistant}>
              <Text accessibilityLiveRegion="polite" style={styles.bubbleAssistantText}>
                正在整理录音…
              </Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        <VoiceHoldButton
          onVoiceCancel={onVoiceCancel}
          onVoiceEnd={onVoiceEnd}
          onVoiceStart={onVoiceStart}
        />
      </View>
    </BottomSheetFrame>
  );
}
