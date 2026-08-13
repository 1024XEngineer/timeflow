/**
 * `@irvingouj/expo-audio-stream` 在 JS 桥上传的是 base64 字符串，不是 ArrayBuffer；
 * WS 端口（VoiceTransportPort）和播放端口都按 ArrayBuffer 设计，转换集中在这里。
 * RN 0.86 / Hermes 已内置 atob/btoa，不需要额外 polyfill。
 */

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
