/**
 * 把一段 PCM 按固定字节数切成连续小块，供原生播放器逐块写入。
 *
 * 根因：`@irvingouj/expo-audio-stream` 的 Android 播放循环写完一块后，会空等「这一块
 * 时长的 50%」才写下一块；而 AudioTrack 缓冲只有 minBufferSize*2（几十 ms）。对一句
 * ~400ms 的帧，50% 延迟 ≈200ms 远超缓冲容量，缓冲在每句之间被抽干，产生静音空隙。
 * 把大帧切成 ~100ms 的小块后，每块的 50% 延迟只有 ~50ms，永远小于缓冲扛得住的时长，
 * 缓冲不再抽干，句间空隙消失。
 *
 * 注意块不能一味切小：每块固定有 base64/桥接/解码/协程开销，块太碎（如 40ms）反而
 * 让开销压过音频、交付 deadline 变紧，实测更卡。100ms 是上下限之间的安全值。
 *
 * 纯数据函数，不碰原生模块，便于单测。
 */
export function splitPcm(buffer: ArrayBuffer, chunkBytes: number): ArrayBuffer[] {
  if (!Number.isFinite(chunkBytes) || chunkBytes <= 0) {
    throw new Error('splitPcm chunkBytes must be positive');
  }
  const total = buffer.byteLength;
  if (total === 0) {
    return [];
  }
  const pieces: ArrayBuffer[] = [];
  for (let offset = 0; offset < total; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, total);
    pieces.push(buffer.slice(offset, end));
  }
  return pieces;
}
