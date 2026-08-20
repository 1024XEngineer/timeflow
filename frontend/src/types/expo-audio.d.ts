declare module 'expo-audio' {
  export function createAudioPlayer(source?: string | number | null): {
    pause: () => void;
    replace: (source: string | number) => void;
    play: () => void;
    volume: number;
    loop: boolean;
  };

  export function setAudioModeAsync(mode: Record<string, unknown>): Promise<void>;
}

declare module '*.mp3' {
  const asset: number;
  export default asset;
}
