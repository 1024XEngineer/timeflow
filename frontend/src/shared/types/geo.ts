/** 中立地理点类型：feature 与地图 adapter 共用，不归属具体供应商。 */
export type MapLocation = {
  address: string;
  latitude: number;
  longitude: number;
  name?: string;
};
