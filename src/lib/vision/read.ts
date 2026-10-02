/**
 * 화면 캡처에서 게임판과 보유 조각을 읽는다.
 *
 * 브라우저의 ImageData와 테스트의 pngjs가 같은 모양(width, height, RGBA 바이트)을
 * 주므로 둘 다 그대로 받는다. DOM이나 캔버스에는 기대지 않아서 워커에서도 돈다.
 *
 * 색 기준은 실제 캡처(test/fixtures)에서 뽑았다.
 *   빈 칸      청록 (95,177,224) 위쪽 ~ (80,191,194) 아래쪽. 칸 사이 격자선은 조금 더 어둡다
 *   블록       채도 높은 분홍·노랑·초록·파랑. 파랑은 B가 250 넘게 올라가서 빈 칸과 갈린다
 *   배치 미리보기  초록 (44,219,130) / (67,245,143), 막힌 칸은 빨강 (255,0,0) X
 *   지워질 줄 강조  밝은 하늘색 (140,235,252)
 *   능력 아이콘  빈 칸 가운데 흰색·보라색 그림. 테두리 쪽은 그대로 청록이다
 */

import { COLS, ROWS, type Board, type Icon, type Shape, shapeFromCells, type Cell } from '../core/board'

export interface RGBAImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

export interface Grid {
  /** 판 왼쪽 위 모서리(격자 바깥선) */
  x: number
  y: number
  /** 칸 한 변의 픽셀 수 */
  pitch: number
}

// ─── 색 판별 ─────────────────────────────────────────────────────────────

const isTeal = (r: number, g: number, b: number) => b - r > 70 && g - r > 55 && r < 125 && b < 240 && g < 214
const isHover = (r: number, g: number, b: number) => g > 200 && r < 110 && b > 100 && b < 170
const isRedX = (r: number, g: number, b: number) => r > 235 && g < 90 && b < 90
const isFlash = (r: number, g: number, b: number) => r >= 118 && g >= 222 && b >= 240 && r < 215
const sat = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b)
const lum = (r: number, g: number, b: number) => (r * 3 + g * 6 + b) / 10

function px(img: RGBAImage, x: number, y: number): [number, number, number] {
  const xi = Math.min(img.width - 1, Math.max(0, Math.round(x)))
  const yi = Math.min(img.height - 1, Math.max(0, Math.round(y)))
  const i = (yi * img.width + xi) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}

// ─── 판 위치 찾기 ────────────────────────────────────────────────────────

/**
 * 화면 어디에 판이 있는지 찾는다.
 *
 * 빈 칸 사이의 격자선은 양옆 청록보다 조금 어둡다. 열마다(행마다) 그런 픽셀이 몇 개인지
 * 세면 격자선 자리에서 봉우리가 서고, 봉우리는 칸 크기 간격으로 늘어선다. 가로 11개,
 * 세로 17개의 봉우리가 같은 간격으로 늘어선 자리를 찾는다.
 *
 * 한 칸 밀린 자리도 선 대부분이 겹쳐서 점수가 비슷하게 나온다. 그래서 판 바깥 한 칸
 * 자리에 선이 있으면 감점해서 판 테두리에 딱 맞는 자리를 고른다.
 */
export function detectGrid(img: RGBAImage): Grid | null {
  const { width: W, height: H } = img
  const teal = new Uint8Array(W * H)
  const L = new Float32Array(W * H)
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2]
    teal[i] = isTeal(r, g, b) ? 1 : 0
    L[i] = lum(r, g, b)
  }
  const d = 3
  const colScore = new Float32Array(W)
  const rowScore = new Float32Array(H)
  for (let y = d; y < H - d; y++) {
    for (let x = d; x < W - d; x++) {
      const i = y * W + x
      if (!teal[i]) continue
      if (teal[i - d] && teal[i + d] && L[i] < L[i - d] - 5 && L[i] < L[i + d] - 5) colScore[x]++
      if (teal[i - d * W] && teal[i + d * W] && L[i] < L[i - d * W] - 5 && L[i] < L[i + d * W] - 5) rowScore[y]++
    }
  }
  const sx = smooth(colScore)
  const sy = smooth(rowScore)

  const fit = (s: Float32Array, n: number, p: number) => {
    let best = -Infinity, at = 0
    const N = s.length
    for (let o = Math.ceil(p); o + (n + 1) * p < N; o++) {
      let v = 0
      for (let k = 0; k <= n; k++) v += s[Math.round(o + k * p)]
      v -= 2 * s[Math.round(o - p)] + 2 * s[Math.round(o + (n + 1) * p)]
      if (v > best) { best = v; at = o }
    }
    return { v: best / (n + 1), at }
  }

  let best: { v: number; grid: Grid } | null = null
  const maxP = Math.min(W / 12, H / 18)
  for (let p = 12; p <= maxP; p += 0.25) {
    const fx = fit(sx, COLS, p)
    const fy = fit(sy, ROWS, p)
    const v = fx.v + fy.v
    if (!best || v > best.v) best = { v, grid: { x: fx.at, y: fy.at, pitch: p } }
  }
  if (!best || best.v < 20) return null
  return settle(img, refine(sx, sy, best.grid))
}

/**
 * 격자선 간격만으로는 한두 칸 밀린 자리와 잘 갈리지 않는다. 판 테두리 바로 바깥은 청록이
 * 아니라서 테두리 선이 봉우리를 거의 만들지 못하기 때문이다.
 * 그래서 판 오른쪽에 붙은 '보유 조각' 카드 세 장이 제자리에 있는지로 최종 자리를 고른다.
 * 카드 왼쪽 띠는 그림이 없는 바탕(흰색·노란색·하늘색)이라 확인하기 좋다.
 */
function settle(img: RGBAImage, g: Grid): Grid {
  let best = g, bestScore = -1
  for (let dy = -3; dy <= 3; dy++) for (let dx = -2; dx <= 2; dx++) {
    const c: Grid = { x: g.x + dx * g.pitch, y: g.y + dy * g.pitch, pitch: g.pitch }
    const s = layoutScore(img, c)
    if (s > bestScore) { bestScore = s; best = c }
  }
  return best
}

const isCardBg = (r: number, g: number, b: number) =>
  (r > 235 && g > 235 && b > 235) || (r > 235 && g > 200 && b < 200 && b > 120) || (b > 200 && r < 60 && g > 140)

function layoutScore(img: RGBAImage, g: Grid): number {
  let s = 0
  for (let i = 0; i < 3; i++) {
    const box = cardBox(g, i)
    for (const t of [0.15, 0.35, 0.5, 0.65, 0.85]) {
      const [r, gg, b] = px(img, box.x0 + 0.12 * g.pitch, box.y0 + t * (box.y1 - box.y0))
      if (isCardBg(r, gg, b)) s += 2
    }
  }
  // 판 안 칸 테두리는 청록(빈 칸)이거나 블록이다. 판 바깥으로 밀리면 이 비율이 떨어진다
  for (let r = 0; r < ROWS; r += 3) for (const c of [0, COLS - 1]) {
    const [R, G, B] = px(img, g.x + (c + 0.22) * g.pitch, g.y + (r + 0.22) * g.pitch)
    const [R2, G2, B2] = px(img, g.x + (c + 0.78) * g.pitch, g.y + (r + 0.78) * g.pitch)
    if (isTeal(R, G, B) || sat(R, G, B) > 70) s += 0.5
    if (isTeal(R2, G2, B2) || sat(R2, G2, B2) > 70) s += 0.5
  }
  return s
}

function smooth(a: Float32Array): Float32Array {
  const o = new Float32Array(a.length)
  for (let i = 1; i < a.length - 1; i++) o[i] = a[i - 1] + a[i] + a[i + 1]
  return o
}

/** 정수 단위로 찾은 시작점과 0.25 단위 간격을 봉우리 무게중심으로 다듬는다 */
function refine(sx: Float32Array, sy: Float32Array, g: Grid): Grid {
  const centroid = (s: Float32Array, n: number, o: number, p: number) => {
    const xs: number[] = []
    for (let k = 0; k <= n; k++) {
      const c = Math.round(o + k * p)
      let w = 0, m = 0
      for (let t = c - 2; t <= c + 2; t++) if (t >= 0 && t < s.length) { w += s[t]; m += s[t] * t }
      xs.push(w > 0 ? m / w : c)
    }
    // 최소제곱으로 xs[k] ≈ o + k·p
    const K = xs.length
    const mk = (K - 1) / 2
    const mx = xs.reduce((a, b) => a + b, 0) / K
    let num = 0, den = 0
    xs.forEach((x, k) => { num += (k - mk) * (x - mx); den += (k - mk) ** 2 })
    const pp = num / den
    return { o: mx - mk * pp, p: pp }
  }
  const cx = centroid(sx, COLS, g.x, g.pitch)
  const cy = centroid(sy, ROWS, g.y, g.pitch)
  return { x: cx.o, y: cy.o, pitch: (cx.p + cy.p) / 2 }
}

// ─── 칸 읽기 ─────────────────────────────────────────────────────────────

export type CellState = 'empty' | 'block' | 'icon-swap' | 'icon-dot' | 'icon' | 'hover' | 'invalid' | 'flash' | 'cursor' | 'unknown'

/** 칸 안쪽 테두리(가장자리에서 22%)를 한 바퀴 돌며 찍는 점들. 가운데의 아이콘이나 커서 끝에 덜 휘둘린다 */
const RING: [number, number][] = []
for (const t of [0.22, 0.5, 0.78]) for (const u of [0.22, 0.78]) { RING.push([t, u]); RING.push([u, t]) }

export function readCell(img: RGBAImage, g: Grid, r: number, c: number): CellState {
  const x0 = g.x + c * g.pitch, y0 = g.y + r * g.pitch

  // 가운데를 촘촘히 훑는다. 바꿔 뽑기 아이콘은 보라색이 넓게 퍼져 있고 주변에 빛번짐이 있어서
  // 테두리만 봐서는 잡히지 않는다. 메이플 커서(흰 손, 마우스 그림)는 검은 외곽선이 있다
  let purple = 0, black = 0, white = 0, blue = 0
  const step = g.pitch / 12
  for (let fy = 0.25; fy <= 0.75; fy += step / g.pitch) for (let fx = 0.25; fx <= 0.75; fx += step / g.pitch) {
    const [R, G, B] = px(img, x0 + fx * g.pitch, y0 + fy * g.pitch)
    if (R + G + B < 200) black++
    else if (R > 205 && G > 205 && B > 205) white++
    // 아이콘 보라 (220,100,250)은 B가 R보다 크다. 분홍 블록 (245,143,230)은 반대다
    else if (R > 120 && B > R + 12 && G < R - 60) purple++
    else if (B > 200 && R < 120 && !isTeal(R, G, B)) blue++
  }
  if (purple >= 6) return 'icon-swap'
  if (black >= 3) return 'cursor'

  let teal = 0, hover = 0, red = 0, flash = 0, colored = 0
  for (const [fx, fy] of RING) {
    const [R, G, B] = px(img, x0 + fx * g.pitch, y0 + fy * g.pitch)
    if (isTeal(R, G, B)) teal++
    else if (isRedX(R, G, B)) red++
    else if (isHover(R, G, B)) hover++
    else if (isFlash(R, G, B)) flash++
    else if (sat(R, G, B) > 70) colored++
  }
  const n = RING.length
  if (red >= 2) return 'invalid'
  if (hover > n / 2) return 'hover'
  if (flash > n / 2) return 'flash'
  if (colored > n / 2) return 'block'
  if (teal * 3 >= n) {
    // 테두리가 청록 쪽인데 가운데에 그림이 있으면 능력 아이콘이 떠 있는 빈 칸이다
    if (white + blue < 4) return teal > n / 2 ? 'empty' : 'unknown'
    return blue >= 3 ? 'icon-dot' : 'icon'
  }
  return 'unknown'
}

export function readCells(img: RGBAImage, g: Grid): CellState[] {
  const out: CellState[] = []
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) out.push(readCell(img, g, r, c))
  return out
}

export interface BoardRead {
  board: Board
  icons: Icon[]
  /** 미리보기·줄 강조가 떠 있어서 판을 믿을 수 없는 상태 */
  busy: boolean
  /** 판이 다른 창에 가려졌다 */
  obscured: boolean
  unknown: number
  /** 커서에 가려 못 읽은 칸 번호(r*10+c). 직전에 읽은 값을 그대로 쓴다 */
  cursor: number[]
  cells: CellState[]
}

export function readBoard(img: RGBAImage, g: Grid): BoardRead {
  const cells = readCells(img, g)
  const board = new Array(ROWS).fill(0)
  const icons: Icon[] = []
  let busy = false, unknown = 0
  const cursor: number[] = []
  cells.forEach((s, i) => {
    const r = Math.floor(i / COLS), c = i % COLS
    if (s === 'block') board[r] |= 1 << c
    else if (s === 'icon-swap' || s === 'icon-dot' || s === 'icon') icons.push({ r, c, kind: s === 'icon-dot' ? 'dot' : 'swap' })
    else if (s === 'hover' || s === 'invalid' || s === 'flash') busy = true
    else if (s === 'unknown') unknown++
    else if (s === 'cursor') cursor.push(i)
  })
  // 아이콘은 판에 최대 3개다. 그보다 많거나 못 읽은 칸이 많으면 무언가(게임 오버 창 등)가 판을 덮고 있다
  const obscured = icons.length > 3 || unknown > 6
  return { board, icons, busy, obscured, unknown, cursor, cells }
}

// ─── 보유 조각 읽기 ──────────────────────────────────────────────────────

/*
 * 오른쪽 '보유 조각' 카드 세 장의 자리. 판 칸 크기(pitch) 단위로 판 왼쪽 위에서 잰다.
 * 게임 창은 통째로 같은 비율로 커지고 작아지므로 비율로 들고 있으면 된다.
 * 미리보기 그림은 판 칸의 정확히 1/3 크기로 그려진다.
 */
const CARD_X0 = 10.55
const CARD_X1 = 12.72
const CARD_TOP = 0.93
const CARD_H = 2.68
const CARD_STEP = 2.87
const MINI = 1 / 3

export type CardState = 'piece' | 'used' | 'unknown'

export interface CardRead {
  state: CardState
  selected: boolean
  shape: Shape | null
}

export function cardBox(g: Grid, i: number) {
  const p = g.pitch
  return {
    x0: g.x + CARD_X0 * p,
    x1: g.x + CARD_X1 * p,
    y0: g.y + (CARD_TOP + i * CARD_STEP) * p,
    y1: g.y + (CARD_TOP + i * CARD_STEP + CARD_H) * p,
  }
}

export function readCard(img: RGBAImage, g: Grid, i: number): CardRead {
  const box = cardBox(g, i)
  const p = g.pitch
  // 카드 바탕색: 왼쪽 위 안쪽 구석
  const [br, bg, bb] = px(img, box.x0 + 0.2 * p, box.y0 + 0.25 * p)
  if (bb > 200 && br < 60 && bg > 140) return { state: 'used', selected: false, shape: null }
  const white = br > 235 && bg > 235 && bb > 235
  const yellow = br > 235 && bg > 200 && bb < 200
  if (!white && !yellow) return { state: 'unknown', selected: false, shape: null }

  // 바탕과 확연히 다른 픽셀을 조각으로 본다. 노란 카드 위 노란 조각도 테두리·명암 차이로 잡힌다
  // 선택된 카드는 테두리가 두꺼워져서 안쪽으로 넉넉히 들어가서 본다
  const x0 = Math.ceil(box.x0 + 0.25 * p), x1 = Math.floor(box.x1)
  const y0 = Math.ceil(box.y0 + 0.2 * p), y1 = Math.floor(box.y1 - 0.3 * p)
  const W = x1 - x0, H = y1 - y0
  const mask = new Uint8Array(W * H)
  const colCnt = new Int32Array(W), rowCnt = new Int32Array(H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, gg, b] = px(img, x0 + x, y0 + y)
    const diff = Math.abs(r - br) + Math.abs(gg - bg) + Math.abs(b - bb)
    const nearWhite = r > 225 && gg > 225 && b > 225
    if (diff > 90 && !nearWhite) { mask[y * W + x] = 1; colCnt[x]++; rowCnt[y]++ }
  }
  const minRun = 3
  let left = -1, right = -1, top = -1, bottom = -1
  for (let x = 0; x < W; x++) if (colCnt[x] >= minRun) { if (left < 0) left = x; right = x }
  for (let y = 0; y < H; y++) if (rowCnt[y] >= minRun) { if (top < 0) top = y; bottom = y }
  if (left < 0 || top < 0) return { state: 'unknown', selected: yellow, shape: null }

  const m = p * MINI
  const bw = right - left + 1, bh = bottom - top + 1
  const cols = Math.max(1, Math.round(bw / m)), rows = Math.max(1, Math.round(bh / m))
  const cw = bw / cols, ch = bh / rows
  const cells: Cell[] = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let hit = 0, tot = 0
    for (let dy = 0.3; dy <= 0.71; dy += 0.2) for (let dx = 0.3; dx <= 0.71; dx += 0.2) {
      const x = Math.floor(left + (c + dx) * cw), y = Math.floor(top + (r + dy) * ch)
      tot++
      hit += mask[y * W + x]
    }
    if (hit * 2 > tot) cells.push([r, c])
  }
  if (!cells.length) return { state: 'unknown', selected: yellow, shape: null }
  return { state: 'piece', selected: yellow, shape: shapeFromCells(cells) }
}

export function readCards(img: RGBAImage, g: Grid): CardRead[] {
  return [0, 1, 2].map((i) => readCard(img, g, i))
}
