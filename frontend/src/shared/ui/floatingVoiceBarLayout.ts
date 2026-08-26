import { spacing } from './theme';

export const FLOATING_VOICE_BAR_HEIGHT = 52;

export function floatingVoiceBarBottomOffset(bottomInset: number): number {
  return Math.max(spacing.xl, bottomInset + spacing.md);
}

export function floatingVoiceViewportBottomInset(bottomInset: number): number {
  return floatingVoiceBarBottomOffset(bottomInset) + FLOATING_VOICE_BAR_HEIGHT + spacing.md;
}
