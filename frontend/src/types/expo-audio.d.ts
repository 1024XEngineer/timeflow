declare module 'expo-audio' {
  export type AudioStatus = {
    playing?: boolean;
    error?: string | null;
  };

  export function createAudioPlayer(source?: string | null): {
    pause: () => void;
    replace: (source: string) => void;
    play: () => void;
    volume: number;
    playing?: boolean;
    addListener?: (
      eventName: 'playbackStatusUpdate',
      listener: (status: AudioStatus) => void,
    ) => { remove: () => void };
  };

  export function setAudioModeAsync(mode: Record<string, unknown>): Promise<void>;
}
