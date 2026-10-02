/**
 * 오른쪽 '보유 능력' 칸의 숫자 모양 읽기: 점 찍기·바꿔 뽑기 버튼의 개수 배지, '다음 능력 획득까지 N번',
 * '능력 보유 가능 개수 N/7'.
 *
 * 능력 개수를 배치·아이콘으로 따라가며 세면 커서·미리보기 오독 하나로 개수가 틀어지고 되돌릴 길이 없었다.
 * 게임이 늘 같은 자리에 개수를 그려 주므로 그걸 읽는다.
 *
 * 여기서는 숫자 하나의 '모양'만 다룬다:
 *   - feature: 표본과 견줄 특징 (격자 채움 비율)
 *   - guess:   글꼴과 상관없이 획 구조만 보고 짐작한 숫자 (처음 보는 모양용)
 * 무엇을 믿고 개수를 정할지는 core/counts.ts가 한다.
 *
 * 캡처로 확인한 것 (칸 36.6px·48.8px 두 크기):
 *   - 배지는 각진 픽셀 글꼴, 판넬은 굵고 둥근 글꼴이라 같은 숫자도 모양이 전혀 다르다 (표본을 따로 둔다)
 *   - 판넬 글꼴은 화면 크기가 달라도 같은 숫자끼리 가깝다 (거리 3 안쪽, 다른 숫자는 8 이상)
 *   - 배지 글꼴은 화면 크기가 다르면 같은 숫자끼리도 다른 숫자만큼 벌어진다 (3끼리 5.0, 0과 6이 6.0).
 *     같은 크기에서는 픽셀까지 똑같다 (거리 0). 그래서 배지는 '같은 크기에서 본 모양'과 똑같을 때만 표본을 믿는다
 *
 * 자리는 판 왼쪽 위에서 판 칸 크기(pitch) 단위로 쟀다.
 */
import type { Grid, RGBAImage } from './read'

export type Pool = 'badge' | 'panel'
export interface Spot { cx: number; cy: number; hw: number; hh: number; pool: Pool }

/** 숫자가 그려지는 범위(캡처 14장에서 잰 값)를 여백 0.05칸 넘게 두고 감싼다 */
export const SPOTS = {
  /** 점 찍기 버튼 오른쪽 동그라미 배지 (흰 노랑 숫자, 파란 바탕). 숫자 x 14.06~14.29, y 14.08~14.42 */
  dot: { cx: 14.175, cy: 14.25, hw: 0.2, hh: 0.26, pool: 'badge' },
  /** 바꿔 뽑기 버튼 배지 (흰 노랑 숫자, 보라 바탕). 숫자 x 14.17~14.41, y 15.47~15.79 */
  swap: { cx: 14.29, cy: 15.63, hw: 0.2, hh: 0.26, pool: 'badge' },
  /** '다음 능력 획득까지 N번'의 N (짙은 청록 숫자, 하늘색 바탕). 숫자 x 12.62~12.90, y 11.41~11.88. 오른쪽 '번'은 옅어서 빠진다 */
  next: { cx: 12.76, cy: 11.645, hw: 0.24, hh: 0.32, pool: 'panel' },
  /** '능력 보유 가능 개수 N/7'의 N. 숫자 x 12.43~12.70, y 12.83~13.30. 오른쪽 '/7'은 옅어서 빠진다 */
  held: { cx: 12.565, cy: 13.065, hw: 0.24, hh: 0.32, pool: 'panel' },
} satisfies Record<string, Spot>

/** 숫자 글자색 */
const INK: Record<Pool, [number, number, number]> = { badge: [255, 230, 163], panel: [27, 137, 154] }

/** 잘라 낸 숫자 하나. data는 픽셀마다 '글자색에 얼마나 가까운가' 0~1 (경계 픽셀은 중간값) */
export interface Patch { w: number; h: number; data: Float32Array }

/** 그 자리의 숫자 덩어리를 잘라 낸다. 숫자가 안 보이거나 커서 등에 가려졌으면 null (why에 까닭) */
export function glyphPatch(img: RGBAImage, g: Grid, spot: Spot, why?: { v: string }): Patch | null {
  const fail = (v: string) => { if (why) why.v = v; return null }
  const p = g.pitch
  const x0 = Math.floor(g.x + (spot.cx - spot.hw) * p), x1 = Math.ceil(g.x + (spot.cx + spot.hw) * p)
  const y0 = Math.floor(g.y + (spot.cy - spot.hh) * p), y1 = Math.ceil(g.y + (spot.cy + spot.hh) * p)
  if (x0 < 0 || y0 < 0 || x1 >= img.width || y1 >= img.height) return fail('자리가 화면 밖')
  const W = x1 - x0 + 1, H = y1 - y0 + 1
  if (W < 6 || H < 6) return fail('화면이 너무 작음')
  const N = W * H

  // 바탕색: 가장 흔한 색 (16단계로 뭉쳐서 센다)
  const bucket = new Map<number, [number, number, number, number]>()
  let foreign = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((y0 + y) * img.width + x0 + x) * 4
    const r = img.data[i], gg = img.data[i + 1], b = img.data[i + 2]
    // 커서(흰 손, 짙은 외곽선)의 색은 이 자리에 원래 없다 (캡처 14장 × 네 자리에서 0픽셀)
    if ((r > 240 && gg > 240 && b > 240) || (r < 70 && gg < 70 && b < 70)) foreign++
    const k = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4)
    const e = bucket.get(k)
    if (e) { e[0] += r; e[1] += gg; e[2] += b; e[3]++ } else bucket.set(k, [r, gg, b, 1])
  }
  if (foreign > 2) return fail('가려짐(커서 등)')
  let top: [number, number, number, number] | null = null
  for (const e of bucket.values()) if (!top || e[3] > top[3]) top = e
  const bg = [top![0] / top![3], top![1] / top![3], top![2] / top![3]]
  // 바탕이 제 색이 아니면 다른 화면이다 (능력 꽉 참 주황 칸, 눌린 버튼, 가려짐 등)
  const bgOk = spot.pool === 'panel' ? bg[0] > 150 && bg[1] > 220 && bg[2] > 220 : bg[2] > 150 && bg[0] < 190 && bg[1] < 190
  if (!bgOk) return fail(`바탕색이 다름 ${bg.map(Math.round).join(',')}`)
  const ink = INK[spot.pool]
  const dr = ink[0] - bg[0], dg = ink[1] - bg[1], db = ink[2] - bg[2]
  const dd = dr * dr + dg * dg + db * db

  // 픽셀마다 '바탕에서 글자색 쪽으로 얼마나 갔나' 0~1
  const t = new Float32Array(N)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((y0 + y) * img.width + x0 + x) * 4
    const v = ((img.data[i] - bg[0]) * dr + (img.data[i + 1] - bg[1]) * dg + (img.data[i + 2] - bg[2]) * db) / dd
    t[y * W + x] = v < 0 ? 0 : v > 1 ? 1 : v
  }

  // 이어진 덩어리로 나눈다. 가운데에 가장 가까운 큰 덩어리가 숫자다 (잡티는 버린다)
  const label = new Int32Array(N).fill(-1)
  const comps: { n: number; minx: number; maxx: number; miny: number; maxy: number; id: number }[] = []
  for (let s = 0; s < N; s++) {
    if (t[s] <= 0.5 || label[s] >= 0) continue
    const id = comps.length, stack = [s]
    const c = { n: 0, minx: W, maxx: 0, miny: H, maxy: 0, id }
    label[s] = id
    while (stack.length) {
      const k = stack.pop()!, x = k % W, y = (k - x) / W
      c.n++; c.minx = Math.min(c.minx, x); c.maxx = Math.max(c.maxx, x); c.miny = Math.min(c.miny, y); c.maxy = Math.max(c.maxy, y)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const nk = ny * W + nx
        if (t[nk] > 0.5 && label[nk] < 0) { label[nk] = id; stack.push(nk) }
      }
    }
    comps.push(c)
  }
  // 숫자 높이는 판 칸의 0.27(배지)~0.47(판넬)이다. 0.2보다 낮은 덩어리는 잡티
  const tall = comps.filter((c) => c.maxy - c.miny + 1 >= 0.2 * p)
  if (!tall.length) return fail('숫자가 안 보임')
  const mid = (W - 1) / 2
  tall.sort((a, b) => Math.abs((a.minx + a.maxx) / 2 - mid) - Math.abs((b.minx + b.maxx) / 2 - mid))
  const d = tall[0]
  // 자리 가장자리에 닿은 덩어리는 잘린 것이다 (자리가 어긋났거나 다른 그림)
  if (d.minx === 0 || d.miny === 0 || d.maxx === W - 1 || d.maxy === H - 1) return fail('숫자가 자리 밖으로 나감')
  const w = d.maxx - d.minx + 1, h = d.maxy - d.miny + 1
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (d.miny + y) * W + d.minx + x
    data[y * w + x] = label[k] >= 0 && label[k] !== d.id ? 0 : t[k]
  }
  return { w, h, data }
}

/** 숫자 모양을 이 격자로 줄여 칸마다 채워진 비율을 잰다 */
const GW = 5, GH = 7

/** 표본과 견줄 특징: 격자 칸별 채움 비율 35개(칸에 걸친 넓이만큼 나눠 더한다) + 가로세로 비 */
export function featureOf(pt: Patch): number[] {
  const f: number[] = []
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const ax = (gx / GW) * pt.w, bx = ((gx + 1) / GW) * pt.w, ay = (gy / GH) * pt.h, by = ((gy + 1) / GH) * pt.h
    let sum = 0
    for (let y = Math.floor(ay); y < by; y++) {
      const hy = Math.min(by, y + 1) - Math.max(ay, y)
      for (let x = Math.floor(ax); x < bx; x++) sum += pt.data[y * pt.w + x] * hy * (Math.min(bx, x + 1) - Math.max(ax, x))
    }
    f.push(Math.round((sum / ((bx - ax) * (by - ay))) * 100) / 100)
  }
  // 가로세로 비: 격자 칸 두 개만큼의 무게
  f.push(Math.round((pt.w / pt.h) * 200) / 100)
  return f
}

/**
 * 획 구조만 보고 숫자를 짐작한다 (0~7). 글꼴이 달라도 통하는 것만 본다:
 * 폭(1), 아랫줄(없으면 4·7), 가운데 가로줄, 왼쪽·오른쪽 세로획이 어디에 있나.
 * 배지·판넬 두 글꼴의 캡처 표본 전부에서 맞는 걸 test/digits.test.ts가 지킨다.
 * 표본이 없는 숫자(배지 4·5·7, 판넬 3·6)는 이걸로 짐작하고, counts가 합으로 검산한 뒤 배운다
 */
export function guessDigit(pt: Patch): number {
  const { w, h } = pt
  if (w / h < 0.44) return 1
  const on = (x: number, y: number) => pt.data[y * w + x] > 0.5
  /** 높이 a~b 구간에서 가장 긴 가로 줄(이어진 잉크)의 폭 대비 길이 */
  const bar = (a: number, b: number) => {
    let best = 0
    for (let y = 0; y < h; y++) {
      const c = (y + 0.5) / h
      if (c < a || c >= b) continue
      let run = 0
      for (let x = 0; x < w; x++) { run = on(x, y) ? run + 1 : 0; if (run > best) best = run }
    }
    return best / w
  }
  /** 높이 a~b 구간의 줄 가운데, 왼쪽(또는 오른쪽) 가장자리 쪽에 잉크가 있는 줄의 비율 */
  const side = (left: boolean, a: number, b: number) => {
    let rows = 0, hit = 0
    for (let y = 0; y < h; y++) {
      const c = (y + 0.5) / h
      if (c < a || c >= b) continue
      rows++
      for (let x = 0; x < w; x++) {
        const cx = (x + 0.5) / w
        if ((left ? cx <= 0.3 : cx >= 0.7) && on(x, y)) { hit++; break }
      }
    }
    return rows ? hit / rows : 0
  }
  // 아랫줄은 맨 아래 12%에서만 본다. 판넬 4의 가로줄(높이 70~82%)이 번져도 아랫줄로 보지 않게.
  // 화면이 작아 줄 수가 적으면 맨 아래 두 줄까지 본다
  const bottom = bar(Math.min(0.88, 1 - 2 / h), 1) >= 0.5
  const middle = bar(0.25, 0.8) >= 0.7
  if (!bottom) return middle ? 4 : 7
  if (side(false, 0.6, 0.85) < 0.75) return 2
  if (side(true, 0.5, 0.75) >= 0.75) return middle ? 6 : 0
  // 5는 위쪽 세로획이 왼쪽에만 있다. 3은 오른쪽에 있다 (왼쪽 위 갈고리가 번져 보여도 3이다)
  return side(true, 0.15, 0.4) >= 0.75 && side(false, 0.15, 0.4) < 0.75 ? 5 : 3
}

export function dist(a: number[], b: number[]) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s
}

/** 숫자별 표본 모양들 */
export type Shapes = Record<number, number[][]>

/**
 * 판넬 글꼴('다음 능력 N번', '보유 N/7') 숫자 모양. 캡처(test/fixtures)에서 모았다. 3·6은 캡처가 없다.
 * 배지 글꼴 표본은 두지 않는다: 같은 자리·같은 화면 크기에서도 캡처마다 4.5까지 벌어져 다른 숫자(5.9)와 못 가른다
 */
export const PANEL_SHAPES: Shapes = {
  0: [
    [0.42, 0.85, 0.88, 0.86, 0.6, 0.77, 0.73, 0.22, 0.61, 0.98, 0.8, 0.64, 0.08, 0.51, 1, 0.8, 0.64, 0.07, 0.51, 1, 0.8, 0.64, 0.07, 0.51, 1, 0.77, 0.75, 0.25, 0.62, 0.99, 0.34, 0.8, 0.8, 0.8, 0.49, 1.06],
    [0.4, 0.84, 0.89, 0.87, 0.6, 0.75, 0.75, 0.23, 0.58, 0.98, 0.78, 0.66, 0.08, 0.47, 1, 0.78, 0.66, 0.08, 0.47, 1, 0.78, 0.66, 0.08, 0.47, 1, 0.75, 0.76, 0.25, 0.59, 0.99, 0.33, 0.8, 0.8, 0.81, 0.52, 1.06],
  ],
  1: [
    [0.26, 0.49, 0.78, 0.88, 0.61, 0.46, 0.7, 0.91, 1, 0.74, 0.04, 0.24, 0.7, 1, 0.74, 0.02, 0.2, 0.67, 1, 0.73, 0.02, 0.2, 0.67, 1, 0.73, 0.02, 0.19, 0.67, 1, 0.73, 0.01, 0.1, 0.54, 0.8, 0.54, 0.71],
    [0.14, 0.3, 0.6, 0.74, 0.56, 0.48, 0.75, 0.95, 1, 0.85, 0.08, 0.26, 0.69, 1, 0.85, 0.03, 0.17, 0.64, 1, 0.84, 0.02, 0.17, 0.64, 1, 0.84, 0.02, 0.16, 0.63, 1, 0.84, 0.01, 0.11, 0.6, 0.96, 0.76, 0.71],
  ],
  2: [
    [0.41, 0.85, 0.87, 0.89, 0.6, 0.58, 0.73, 0.3, 0.65, 0.89, 0.11, 0.13, 0.24, 0.79, 0.79, 0.04, 0.31, 0.78, 0.83, 0.34, 0.41, 0.87, 0.71, 0.25, 0.02, 0.75, 0.9, 0.4, 0.24, 0.22, 0.56, 0.82, 0.78, 0.77, 0.71, 1.06],
    [0.46, 0.88, 0.9, 0.89, 0.52, 0.67, 0.72, 0.25, 0.76, 0.86, 0.16, 0.16, 0.22, 0.86, 0.76, 0.02, 0.27, 0.79, 0.87, 0.34, 0.4, 0.87, 0.75, 0.23, 0.03, 0.78, 0.88, 0.25, 0.1, 0.09, 0.76, 0.97, 0.86, 0.85, 0.77, 1.09],
    [0.29, 0.73, 0.82, 0.73, 0.24, 0.61, 0.82, 0.37, 0.86, 0.64, 0.21, 0.25, 0.25, 0.88, 0.58, 0.01, 0.18, 0.79, 0.85, 0.21, 0.29, 0.83, 0.74, 0.21, 0.01, 0.71, 0.92, 0.22, 0.11, 0.08, 0.7, 0.97, 0.82, 0.82, 0.57, 1.18],
    [0.26, 0.68, 0.8, 0.77, 0.44, 0.59, 0.83, 0.41, 0.69, 0.88, 0.19, 0.25, 0.17, 0.68, 0.85, 0, 0.13, 0.63, 0.9, 0.49, 0.25, 0.76, 0.82, 0.39, 0.03, 0.69, 0.92, 0.37, 0.12, 0.09, 0.68, 0.96, 0.84, 0.81, 0.75, 1.06],
  ],
  4: [
    [0, 0.31, 0.87, 0.85, 0.23, 0, 0.73, 0.89, 0.9, 0.27, 0.23, 0.88, 0.59, 0.84, 0.27, 0.57, 0.77, 0.33, 0.84, 0.26, 0.82, 0.56, 0.36, 0.86, 0.36, 0.76, 0.77, 0.79, 0.96, 0.65, 0.11, 0.15, 0.34, 0.86, 0.32, 1.25],
    [0.03, 0.25, 0.8, 0.76, 0.18, 0.02, 0.65, 0.92, 0.87, 0.23, 0.19, 0.86, 0.65, 0.81, 0.23, 0.5, 0.79, 0.39, 0.81, 0.23, 0.78, 0.6, 0.39, 0.84, 0.3, 0.78, 0.8, 0.82, 0.95, 0.61, 0.1, 0.14, 0.37, 0.83, 0.27, 1.27],
    [0.03, 0.16, 0.71, 0.82, 0.26, 0.02, 0.44, 0.9, 0.89, 0.33, 0.11, 0.72, 0.69, 0.78, 0.33, 0.29, 0.84, 0.38, 0.77, 0.33, 0.6, 0.77, 0.42, 0.83, 0.45, 0.51, 0.74, 0.74, 0.93, 0.65, 0.02, 0.07, 0.18, 0.68, 0.29, 1.29],
  ],
  5: [
    [0.57, 0.8, 0.8, 0.8, 0.77, 0.79, 0.75, 0.23, 0.21, 0.19, 0.8, 0.86, 0.63, 0.66, 0.43, 0.66, 0.73, 0.33, 0.69, 0.99, 0.17, 0.14, 0.01, 0.51, 1, 0.7, 0.67, 0.18, 0.61, 0.99, 0.42, 0.82, 0.79, 0.83, 0.57, 1.04],
  ],
  7: [
    [0.63, 0.82, 0.83, 0.87, 0.7, 0.18, 0.28, 0.43, 0.91, 0.72, 0.02, 0.04, 0.54, 0.9, 0.43, 0.01, 0.19, 0.83, 0.78, 0.13, 0.02, 0.52, 0.9, 0.47, 0.01, 0.19, 0.79, 0.79, 0.15, 0, 0.31, 0.8, 0.38, 0.03, 0, 1.06],
  ],
}

/** 판넬: 같은 숫자는 3.7 안쪽, 다른 숫자는 5.6 이상이었다 */
export const PANEL_DIST = 4
/** 둘째로 가까운 숫자와 이만큼은 차이 나야 믿는다 */
export const MIN_GAP = 1.5

/** 표본들 가운데 가장 가까운 숫자. maxDist 안쪽이고 둘째와 확실히 다를 때만 답한다 */
export function matchShape(f: number[], shapes: Shapes, maxDist: number): number | null {
  let best = -1, bd = Infinity, second = Infinity
  for (const [k, list] of Object.entries(shapes)) {
    let d = Infinity
    for (const tpl of list) d = Math.min(d, dist(f, tpl))
    if (d < bd) { second = bd; bd = d; best = +k } else if (d < second) second = d
  }
  if (best < 0 || bd > maxDist || second - bd < MIN_GAP) return null
  return best
}

/** 모양을 기록에 남길 짧은 글자로: '폭x높이:줄마다 16진수' (못 읽는 모양이 나오면 이걸로 규칙을 고친다) */
export function artOf(pt: Patch): string {
  const rows: string[] = []
  for (let y = 0; y < pt.h; y++) {
    let bits = 0
    for (let x = 0; x < pt.w; x++) bits = (bits << 1) | (pt.data[y * pt.w + x] > 0.5 ? 1 : 0)
    rows.push(bits.toString(16))
  }
  return `${pt.w}x${pt.h}:${rows.join('.')}`
}

/** 한 자리에서 읽은 숫자 모양. f: 견줄 특징, guess: 획 구조로 짐작한 숫자, art: 기록에 남길 모양 그림 */
export interface Glyph { f: number[]; guess: number; art: string }
export interface GlyphReads { dots: Glyph | null; swaps: Glyph | null; next: Glyph | null; held: Glyph | null; why: Record<string, string> }

export function readGlyphs(img: RGBAImage, g: Grid): GlyphReads {
  const why: Record<string, string> = {}
  const one = (name: keyof typeof SPOTS): Glyph | null => {
    const w = { v: '' }
    const pt = glyphPatch(img, g, SPOTS[name], w)
    if (!pt) { why[name] = w.v; return null }
    return { f: featureOf(pt), guess: guessDigit(pt), art: artOf(pt) }
  }
  return { dots: one('dot'), swaps: one('swap'), next: one('next'), held: one('held'), why }
}
