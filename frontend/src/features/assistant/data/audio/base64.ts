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
  // 一次拼一个字节会让 Hermes 的字符串拼接退化到接近 O(n²)；按 32KB 一块批量
  // String.fromCharCode 后拼接，拼接次数从「每字节一次」降到「每 32KB 一次」，
  // 对整句 PCM 这种几十上百 KB 的大分片尤其明显。分块上限远低于引擎 apply 的
  // 参数个数上限，避免栈溢出。
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    // Uint8Array 本身就是 array-like，运行时 apply 直接收；这里只是绕开 TS 把
    // fromCharCode 的 rest 参数窄写成 number[] 的类型限制，不做任何运行时拷贝。
    const chunk = bytes.subarray(offset, offset + chunkSize) as unknown as number[];
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}
