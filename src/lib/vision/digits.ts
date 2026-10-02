/**
 * 오른쪽 '보유 능력' 칸의 숫자 읽기: 점 찍기·바꿔 뽑기 버튼의 개수 배지, '다음 능력 획득까지 N번', '능력 보유 가능 개수 N/7'.
 *
 * 능력 개수를 배치·아이콘으로 따라가며 세면 커서·미리보기 오독 하나로 개수가 틀어지고 되돌릴 길이 없었다.
 * 게임이 늘 같은 자리에 개수를 그려 주므로 그걸 읽는다. 0~7 숫자만, 정해진 자리에서, 한 글꼴로 구분하면 되므로
 * 일반 글자 인식이 아니라 모양 맞추기다. 게임 창 크기(판 칸 크기)가 달라도 숫자 모양을 같은 크기로 줄여 비교한다.
 *
 * 자리는 판 왼쪽 위에서 판 칸 크기(pitch) 단위로 쟀다 (칸 36.6px·48.8px 두 크기의 캡처에서 같은 값).
 */
import type { Grid, RGBAImage } from './read'

type Kind = 'badge' | 'panel'
interface Spot { cx: number; cy: number; hw: number; hh: number; kind: Kind }

export const SPOTS = {
  /** 점 찍기 버튼 오른쪽 동그라미 배지 (흰 노랑 숫자, 파란 바탕) */
  dot: { cx: 14.16, cy: 14.25, hw: 0.28, hh: 0.3, kind: 'badge' },
  /** 바꿔 뽑기 버튼 배지 (흰 노랑 숫자, 보라 바탕) */
  swap: { cx: 14.27, cy: 15.65, hw: 0.28, hh: 0.3, kind: 'badge' },
  /** '다음 능력 획득까지 N번'의 N (짙은 청록 숫자, 하늘색 바탕). 오른쪽 '번'은 옅은 색이라 빠진다 */
  next: { cx: 12.79, cy: 11.63, hw: 0.3, hh: 0.32, kind: 'panel' },
  /** '능력 보유 가능 개수 N/7'의 N. 바로 오른쪽 '/'는 따로 떨어진 덩어리라 가장 가까운 덩어리만 쓴다 */
  held: { cx: 12.66, cy: 13.04, hw: 0.22, hh: 0.26, kind: 'panel' },
} satisfies Record<string, Spot>

/** 숫자 모양을 이 격자로 줄여 칸마다 채워진 비율을 잰다 */
const GW = 5, GH = 7

function px(img: RGBAImage, x: number, y: number) {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}

function isGlyph(kind: Kind, [r, g, b]: number[]) {
  // 배지: 흰 노랑 숫자 (바탕 파랑·보라는 R이나 G가 낮다)
  if (kind === 'badge') return r > 185 && g > 175 && b < 235
  // 판넬: 짙은 청록 숫자 (바탕 하늘색은 R이 200 넘고, '번'은 옅은 청록이라 R이 더 높다)
  return r < 110 && g < 190 && b > 90
}

/** 숫자 하나를 잘라 정규화한 특징 (격자 채움 비율들 + 가로세로 비). 숫자가 안 보이면 null */
export function digitFeature(img: RGBAImage, g: Grid, spot: Spot): number[] | null {
  const p = g.pitch
  const x0 = Math.max(0, Math.floor(g.x + (spot.cx - spot.hw) * p)), x1 = Math.min(img.width - 1, Math.ceil(g.x + (spot.cx + spot.hw) * p))
  const y0 = Math.max(0, Math.floor(g.y + (spot.cy - spot.hh) * p)), y1 = Math.min(img.height - 1, Math.ceil(g.y + (spot.cy + spot.hh) * p))
  const W = x1 - x0 + 1, H = y1 - y0 + 1
  if (W < 4 || H < 4) return null
  const mask = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isGlyph(spot.kind, px(img, x0 + x, y0 + y))) mask[y * W + x] = 1

  // 이어진 덩어리로 나눈다. 가운데에 가장 가까운 큰 덩어리가 숫자다 ('/', 테두리 반짝임 등은 버린다)
  const label = new Int32Array(W * H).fill(-1)
  const comps: { n: number; minx: number; maxx: number; miny: number; maxy: number; id: number }[] = []
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || label[s] >= 0) continue
    const id = comps.length, stack = [s]
    const c = { n: 0, minx: W, maxx: 0, miny: H, maxy: 0, id }
    label[s] = id
    while (stack.length) {
      const k = stack.pop()!, x = k % W, y = (k - x) / W
      c.n++; c.minx = Math.min(c.minx, x); c.maxx = Math.max(c.maxx, x); c.miny = Math.min(c.miny, y); c.maxy = Math.max(c.maxy, y)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const nk = ny * W + nx
        if (mask[nk] && label[nk] < 0) { label[nk] = id; stack.push(nk) }
      }
    }
    comps.push(c)
  }
  // 숫자 높이는 판 칸의 약 0.25 이상이다. 그보다 작은 덩어리는 잡티
  const minH = 0.2 * p
  const tall = comps.filter((c) => c.maxy - c.miny + 1 >= minH && c.n >= 0.01 * p * p)
  if (!tall.length) return null
  const mid = W / 2
  tall.sort((a, b) => Math.abs((a.minx + a.maxx) / 2 - mid) - Math.abs((b.minx + b.maxx) / 2 - mid))
  const d = tall[0]
  const bw = d.maxx - d.minx + 1, bh = d.maxy - d.miny + 1
  const f: number[] = []
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const ax = d.minx + (gx / GW) * bw, bx = d.minx + ((gx + 1) / GW) * bw
    const ay = d.miny + (gy / GH) * bh, by = d.miny + ((gy + 1) / GH) * bh
    let hit = 0, tot = 0
    for (let y = Math.floor(ay); y < Math.ceil(by); y++) for (let x = Math.floor(ax); x < Math.ceil(bx); x++) {
      tot++
      if (label[y * W + x] === d.id) hit++
    }
    f.push(tot ? hit / tot : 0)
  }
  // 가로세로 비: '1'과 다른 숫자를 가르는 데 가장 크다. 격자 칸 하나만큼의 무게로 넣는다
  f.push((bw / bh) * 2)
  return f
}

/**
 * 캡처(test/fixtures)에서 모은 숫자 모양. 배지·판넬, 칸 36.6px·48.8px 캡처를 섞었다 (모양을 같은 크기로 줄여서 글꼴 크기와 상관없다).
 * 한 장씩 빼고 나머지로 읽어 보면 54개 중 53개가 맞고, 틀린 하나는 표본이 하나뿐인 6이었다. test/digits.test.ts가 지킨다
 */
export const TEMPLATES: Record<number, number[][]> = {
  0: [
    [0.5, 0.83, 0.5, 0.67, 0.25, 0.83, 0.44, 0, 0.44, 0.83, 1, 0.33, 0, 0.33, 1, 1, 0.33, 0, 0.33, 1, 1, 0.33, 0, 0.33, 1, 1, 0.33, 0, 0.33, 1, 0.75, 0.67, 0.5, 0.67, 0.75, 1.45],
    [0.5, 0.67, 0.5, 0.67, 0.75, 1, 0.67, 0, 0.33, 1, 1, 0.67, 0, 0.33, 1, 1, 0.67, 0, 0.33, 1, 1, 0.67, 0, 0.33, 1, 0.83, 0.67, 0, 0.33, 0.83, 0.25, 0.67, 0.5, 0.67, 0.5, 1.45],
    [0.33, 0.89, 0.89, 0.89, 0.67, 0.83, 0.78, 0.22, 0.78, 1, 1, 0.67, 0, 0.67, 1, 1, 0.67, 0, 0.67, 1, 1, 0.67, 0, 0.67, 1, 0.83, 0.78, 0.33, 0.78, 1, 0.33, 0.89, 1, 0.89, 0.5, 1.06],
  ],
  1: [
    [0.5, 0.75, 1, 1, 1, 0.33, 0.67, 1, 1, 1, 0, 0.5, 1, 1, 1, 0, 0.5, 1, 1, 1, 0, 0.5, 1, 1, 1, 0, 0.5, 1, 1, 1, 0, 0.5, 1, 1, 1, 0.73],
    [0.33, 0.67, 0.83, 1, 0.83, 0.5, 0.67, 0.83, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 0.83, 0.71],
    [0.17, 0.33, 0.67, 0.83, 0.67, 0.5, 0.83, 1, 1, 1, 0, 0.13, 0.63, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0.71],
    [0, 0.25, 0.75, 1, 1, 0.33, 0.5, 0.83, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0, 0, 0.5, 1, 1, 0.73],
  ],
  2: [
    [0.33, 0.89, 0.89, 1, 0.83, 0.5, 0.89, 0.33, 0.78, 1, 0.13, 0.17, 0.25, 0.83, 0.88, 0, 0.11, 0.78, 0.78, 0.17, 0.25, 0.75, 0.67, 0.25, 0, 0.83, 1, 0.56, 0.33, 0.33, 0.67, 1, 1, 1, 0.83, 1.06],
    [0.33, 0.83, 0.5, 0.67, 0.5, 1, 0.67, 0, 0.33, 1, 0.5, 0.33, 0, 0.33, 1, 0, 0, 0.17, 0.67, 0.67, 0, 0.17, 0.67, 0.83, 0.17, 0.17, 0.67, 0.83, 0.17, 0, 0.67, 1, 0.83, 0.5, 0.5, 1.57],
    [0.5, 0.92, 0.88, 1, 0.67, 0.67, 0.67, 0.19, 0.75, 1, 0.17, 0.08, 0.25, 0.92, 0.92, 0, 0.33, 0.81, 0.83, 0.33, 0.42, 0.92, 0.69, 0.17, 0, 0.83, 1, 0.25, 0, 0, 0.83, 1, 0.81, 0.75, 0.75, 1.09],
    [0.17, 0.67, 1, 0.89, 0.5, 0.5, 1, 0.56, 0.78, 1, 0.25, 0.42, 0.17, 0.75, 0.88, 0, 0.11, 0.67, 0.89, 0.33, 0.25, 0.75, 0.75, 0.25, 0, 0.83, 1, 0.33, 0, 0, 0.83, 1, 0.78, 0.67, 0.67, 1.06],
  ],
  3: [
    [0.56, 0.78, 0.67, 0.89, 0.56, 0.67, 0.22, 0, 0.67, 1, 0.11, 0.33, 0.33, 0.78, 0.56, 0.11, 0.33, 0.33, 0.78, 0.56, 0, 0, 0, 0.67, 1, 0.67, 0.22, 0, 0.67, 1, 0.56, 0.78, 0.67, 0.89, 0.56, 1.47],
    [0.5, 0.67, 0.5, 0.67, 0.75, 0.5, 0.33, 0, 0.33, 1, 0, 0.22, 0.33, 0.56, 0.67, 0, 0.33, 0.5, 0.67, 0.75, 0, 0, 0, 0.33, 1, 0.5, 0.33, 0, 0.33, 1, 0.5, 0.67, 0.5, 0.67, 0.75, 1.6],
  ],
  4: [
    [0, 0.17, 1, 1, 0, 0, 0.83, 1, 1, 0, 0.17, 1, 0.5, 1, 0, 0.5, 0.75, 0, 1, 0, 0.83, 0.67, 0.33, 1, 0.33, 0.83, 1, 0.83, 1, 0.67, 0.17, 0.33, 0.5, 1, 0.33, 1.25],
    [0, 0.19, 0.83, 0.94, 0.25, 0, 0.56, 1, 1, 0.33, 0.08, 0.75, 0.58, 0.81, 0.33, 0.5, 0.75, 0, 0.75, 0.33, 0.75, 0.75, 0.08, 0.81, 0.42, 0.92, 0.94, 0.83, 1, 0.83, 0.17, 0.25, 0.33, 0.88, 0.5, 1.18],
    [0, 0.11, 0.67, 1, 0.5, 0, 0.44, 1, 1, 0.5, 0.13, 0.75, 0.67, 0.75, 0.5, 0.5, 0.78, 0.11, 0.67, 0.5, 0.88, 0.83, 0.42, 0.83, 0.75, 0.67, 0.67, 0.78, 1, 1, 0, 0, 0.11, 0.78, 0.67, 1.06],
  ],
  5: [
    [1, 1, 1, 1, 1, 1, 0.5, 0.25, 0.25, 0.25, 1, 0.75, 0.5, 0.5, 0.33, 0.8, 0.53, 0.4, 0.8, 1, 0, 0, 0, 0.67, 1, 0.75, 0.33, 0.17, 0.75, 1, 0.75, 0.92, 0.92, 1, 0.67, 0.96],
  ],
  6: [
    [0.75, 0.67, 0.5, 0.67, 0.25, 1, 0.33, 0, 0.22, 0.17, 1, 0.67, 0.5, 0.33, 0, 1, 0.56, 0.33, 0.67, 0.5, 1, 0.33, 0, 0.67, 1, 1, 0.33, 0, 0.67, 0.83, 0.75, 0.67, 0.5, 0.67, 0.25, 1.45],
  ],
  7: [
    [0.67, 1, 1, 1, 0.83, 0.17, 0.33, 0.56, 1, 0.67, 0, 0, 0.5, 0.92, 0.38, 0, 0, 0.67, 0.67, 0, 0, 0.33, 0.83, 0.33, 0, 0.17, 0.78, 0.67, 0, 0, 0.33, 0.89, 0.44, 0, 0, 1.06],
  ],
}

function dist(a: number[], b: number[]) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s
}

/** 숫자 하나 읽기. 가장 가까운 모양이 충분히 가깝고 둘째와 확실히 다를 때만 답한다 */
export function readDigit(img: RGBAImage, g: Grid, spot: Spot, templates = TEMPLATES): number | null {
  const f = digitFeature(img, g, spot)
  if (!f) return null
  let best = -1, bd = Infinity, second = Infinity
  for (const [k, list] of Object.entries(templates)) {
    const d = Math.min(...list.map((t) => dist(f, t)))
    if (d < bd) { second = bd; bd = d; best = +k } else if (d < second) second = d
  }
  if (best < 0 || bd > MAX_DIST || second - bd < MIN_GAP) return null
  return best
}

// 같은 숫자는 크기가 달라도 4.3 안쪽, 다른 숫자는 6.1 넘게 떨어졌다
const MAX_DIST = 5
const MIN_GAP = 2

export interface AbilityNumbers { dots: number | null; swaps: number | null; next: number | null; held: number | null }

export function readAbilityNumbers(img: RGBAImage, g: Grid): AbilityNumbers {
  return {
    dots: readDigit(img, g, SPOTS.dot),
    swaps: readDigit(img, g, SPOTS.swap),
    next: readDigit(img, g, SPOTS.next),
    held: readDigit(img, g, SPOTS.held),
  }
}
