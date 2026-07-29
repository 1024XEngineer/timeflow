export const colors = {
  // Only still here so the outgoing HomeScreen keeps compiling. Dropped once
  // the new screens replace it.
  text: '#17212B',
  background: '#F4F5F1',
  surface: '#FFFFFF',
  surfaceTint: '#E9ECE7',
  deep: '#15352B',
  ink: '#1B2923',
  sub: '#6C7972',
  muted: '#98A29C',
  line: '#DDE4DE',
  lime: '#D7F36A',
  limeSoft: '#EEF5D6',
  mint: '#DDEFE5',
  coral: '#E98C70',
  purple: '#8E86D7',
  peach: '#FFE1D6',
  violet: '#E8E4FF',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 20,
  xl: 24,
} as const;

export const radii = {
  sm: 10,
  md: 14,
  lg: 19,
  xl: 24,
} as const;
