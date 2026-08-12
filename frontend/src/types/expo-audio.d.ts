declare module 'expo-audio' {
  export function createAudioPlayer(source?: string | null): {
    pause: () => void;
    replace: (source: string) => void;
    play: () => void;
    volume: number;
  };

  export function setAudioModeAsync(mode: Record<string, unknown>): Promise<void>;
}
