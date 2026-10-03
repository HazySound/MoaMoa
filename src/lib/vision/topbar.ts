/**
 * 게임 위쪽 표시줄의 숫자 읽기: '점수 N', '제거한 줄 수 N', '최고 점수 N'.
 *
 * 왜: 지운 줄 수를 배치로 따라 세면 화면 기준으로 다시 맞출 때마다 그 사이 지운 줄이 빠진다
 * (16만 점 판에서 도우미 381줄, 실제 406줄). 줄 수는 단계(조각 확률)를 정하므로 화면 숫자를 읽어 맞춘다.
 * 점수도 같이 읽어 판 기록을 게임과 맞춘다.
 *
 * 캡처 16장에서 잰 자리 (판 왼쪽 위 기준, 칸 단위): 숫자는 오른쪽 정렬이고 글자 폭은 숫자 0.22칸, 1과 쉼표 0.11칸.
 *   점수      오른쪽 끝 4.64, 왼쪽 이름표 '점수'는 1.26까지
 *   줄 수     오른쪽 끝 9.56, 이름표 '제거한 줄 수'는 7.57까지
 *   최고 점수 오른쪽 끝 14.47, 이름표는 11.91까지
 * 글자는 밝은 황갈색, 바탕은 짙은 갈색. 세로 범위 -1.55 ~ -1.02칸.
 */
import type { Grid, RGBAImage } from './read'
import { guessDigit, type Patch } from './digits'

export interface TopBar { score: number | null; lines: number | null; best: number | null }

/** 숫자가 들어가는 가로 범위 (칸 단위). 이름표를 넘지 않게 왼쪽을 자른다 */
const WINDOWS = { score: [2.3, 4.8], lines: [8.0, 9.75], best: [12.1, 14.65] } as const
const Y0 = -1.55, Y1 = -1.02

function isInk(r: number, g: number, b: number) { return r > 185 && g > 170 && b > 150 }

/** 한 창 안의 밝은 글자들을 왼쪽부터 읽어 수로 만든다. 글자 하나라도 못 읽으면 null */
function readNumber(img: RGBAImage, g: Grid, win: readonly [number, number]): number | null {
  const p = g.pitch
  const x0 = Math.round(g.x + win[0] * p), x1 = Math.round(g.x + win[1] * p)
  const y0 = Math.round(g.y + Y0 * p), y1 = Math.round(g.y + Y1 * p)
  if (x0 < 0 || y0 < 0 || x1 >= img.width || y1 >= img.height) return null
  const W = x1 - x0, H = y1 - y0
  const on = new Uint8Array(W * H)
  const col = new Int32Array(W)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((y0 + y) * img.width + x0 + x) * 4
    if (isInk(img.data[i], img.data[i + 1], img.data[i + 2])) { on[y * W + x] = 1; col[x]++ }
  }
  let text = ''
  let x = 0
  while (x < W) {
    if (!col[x]) { x++; continue }
    let e = x
    while (e < W && col[e]) e++
    let top = H, bot = -1
    for (let yy = 0; yy < H; yy++) for (let xx = x; xx < e; xx++) if (on[yy * W + xx]) { top = Math.min(top, yy); bot = Math.max(bot, yy) }
    const h = bot - top + 1, w = e - x
    if (h >= 0.22 * p) {
      // 창 가장자리에 걸린 글자는 잘린 것이다 (이름표 끝이나 다른 칸)
      if (x === 0 || e === W) return null
      const pt: Patch = { w, h, data: new Float32Array(w * h) }
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) pt.data[yy * w + xx] = on[(top + yy) * W + x + xx]
      text += String(guessDigit(pt))
    } else if (h >= 0.05 * p && bot >= H * 0.6) {
      // 쉼표: 짧고 아래쪽에 있다
      if (!text) return null
    } else if (h >= 0.12 * p) return null
    // 아주 작은 잡티(이파리 가장자리 등)는 넘긴다
    x = e
  }
  if (!text || text.length > 6) return null
  // 쉼표 자리를 확인한다: 네 자리 이상이면 쉼표가 있어야 한다 (글자 수로만 본다)
  return +text
}

export function readTopBar(img: RGBAImage, g: Grid): TopBar {
  return { score: readNumber(img, g, WINDOWS.score), lines: readNumber(img, g, WINDOWS.lines), best: readNumber(img, g, WINDOWS.best) }
}
