export interface CropInfo {
  kind: 'point' | 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string; // #rrggbb
}

/** 生成 yyyyMMdd-HHmmss 格式时间戳 */
export function timestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function safeSegment(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '_');
}

/**
 * 构造与截图内容相关的文件名：
 *   点：  {prefix}_x{x}_y{y}_{主色}_{时间戳}.png
 *   框选：{prefix}_r{x}_{y}_{w}x{h}_{主色}_{时间戳}.png
 * 重名时 duplicate 从 1 开始追加。
 */
export function buildCropName(prefix: string, info: CropInfo, duplicate = 0): string {
  const pre = safeSegment(prefix.trim() || 'crop');
  const color = (info.color || '#ffffff').replace('#', '').toLowerCase();
  const core =
    info.kind === 'rect'
      ? `${pre}_r${info.x}_${info.y}_${info.w}x${info.h}_${color}`
      : `${pre}_x${info.x}_y${info.y}_${color}`;
  return `${core}_${timestamp()}${duplicate > 0 ? `_${duplicate}` : ''}.png`;
}

/** 整屏保存的默认文件名 */
export function buildFullName(serial: string): string {
  const name = safeSegment(serial || 'screen');
  return `full_${name}_${timestamp()}.png`;
}
