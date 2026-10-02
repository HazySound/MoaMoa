/** 테스트 공용 도구 */
import type { Grid } from '../src/lib/vision/read'

/** 칸 하나를 흰색 쪽으로 a만큼 섞는다 (아이콘이 반짝이며 칸이 밝아지는 것 흉내) */
export function whiten(img: { width: number; height: number; data: ArrayLike<number> }, g: Grid, r: number, c: number, a: number) {
  const out = { width: img.width, height: img.height, data: Uint8Array.from(img.data) }
  for (let y = Math.floor(g.y + r * g.pitch); y < g.y + (r + 1) * g.pitch; y++) for (let x = Math.floor(g.x + c * g.pitch); x < g.x + (c + 1) * g.pitch; x++) {
    const i = (y * img.width + x) * 4
    for (let k = 0; k < 3; k++) out.data[i + k] = Math.round(img.data[i + k] + (255 - img.data[i + k]) * a)
  }
  return out
}
