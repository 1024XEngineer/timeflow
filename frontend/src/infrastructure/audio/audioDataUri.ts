const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const MIME_BY_FORMAT: Record<string, string> = {
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  wave: 'audio/wav',
};

export function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1]! : 0;
    const third = hasThird ? bytes[index + 2]! : 0;
    const value = (first << 16) | (second << 8) | third;

    output += BASE64_ALPHABET[(value >>> 18) & 63];
    output += BASE64_ALPHABET[(value >>> 12) & 63];
    output += hasSecond ? BASE64_ALPHABET[(value >>> 6) & 63] : '=';
    output += hasThird ? BASE64_ALPHABET[value & 63] : '=';
  }
  return output;
}

export function buildAudioDataUri(bytes: Uint8Array, audioFormat: string): string {
  const normalizedFormat = audioFormat.trim().toLowerCase().replace(/^\./, '');
  if (!/^[a-z0-9][a-z0-9.+-]{0,31}$/.test(normalizedFormat)) {
    throw new Error('Unsupported reminder audio format');
  }
  const mime = MIME_BY_FORMAT[normalizedFormat] ?? `audio/${normalizedFormat}`;
  return `data:${mime};base64,${encodeBase64(bytes)}`;
}
