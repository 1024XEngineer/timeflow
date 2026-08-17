export type WebAudioRuntime = {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createAudioContext: (sampleRateHz?: number) => AudioContext;
};

export function createBrowserAudioRuntime(): WebAudioRuntime {
  return {
    createAudioContext: (sampleRateHz) => {
      const AudioContextCtor =
        globalThis.AudioContext ??
        (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AudioContextCtor == null) {
        throw new Error('当前浏览器不支持 Web Audio');
      }
      return sampleRateHz == null
        ? new AudioContextCtor()
        : new AudioContextCtor({ sampleRate: sampleRateHz });
    },
    getUserMedia: (constraints) => {
      const mediaDevices = globalThis.navigator?.mediaDevices;
      if (mediaDevices?.getUserMedia == null) {
        return Promise.reject(new Error('当前浏览器不支持麦克风'));
      }
      return mediaDevices.getUserMedia(constraints);
    },
  };
}
