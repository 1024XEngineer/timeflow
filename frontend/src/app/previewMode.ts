/** PR / 本地预览用的离线演示开关，由打包时的 EXPO_PUBLIC_MOCK_MODE 注入。 */
export function isMockMode(): boolean {
  const value = process.env.EXPO_PUBLIC_MOCK_MODE?.trim().toLowerCase();
  return value === '1' || value === 'true';
}
