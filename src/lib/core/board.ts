/**
 * 게임판과 조각의 규칙.
 *
 * 판은 가로 10칸 × 세로 16칸이다. 한 줄을 10비트 정수 하나로 들고 다닌다
 * (c번째 비트가 1이면 c열이 차 있다). 탐색 중에 판을 수십만 번 복사하고
 * 비교하므로 칸 배열보다 정수 16개가 훨씬 싸다.
 *
 * 테트리스와 달리 줄이 지워져도 위 블록이 내려오지 않는다. 지워진 줄은
 * 그 자리에서 비기만 한다(플레이2 → 플레이3 캡처로 확인).
 */

export const COLS = 10
export const ROWS = 16
export const FULL_ROW = (1 << COLS) - 1

/** 한 번에 지운 줄 수별 점수. 공식 안내: 300 · 1,200 · 2,700 · 4,800 · 7,500 = 300 × n² */
export const lineScore = (n: number) => 300 * n * n
export const ABILITY_SCORE = 50
/** 능력은 합쳐서 7개까지만 들 수 있다. 꽉 차면 아이콘 줄을 지워도 얻지 못한다 */
export const ABILITY_CAP = 7

export type Board = number[]

export type IconKind = 'swap' | 'dot'
export interface Icon { r: number; c: number; kind: IconKind }

export const emptyBoard = (): Board => new Array(ROWS).fill(0)

export function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

export const filledCount = (b: Board) => b.reduce((s, row) => s + popcount(row), 0)

export const isFilled = (b: Board, r: number, c: number) => ((b[r] >> c) & 1) === 1

export function boardKey(b: Board): string {
  return String.fromCharCode(...b)
}

// ─── 조각 ────────────────────────────────────────────────────────────────

/** 한 방향으로 놓인 조각 모양. rows[i]는 i번째 줄의 비트 마스크(0열이 최하위 비트) */
export interface Shape {
  w: number
  h: number
  rows: number[]
  cells: number
  /** 같은 모양인지 비교할 때 쓰는 문자열 */
  key: string
}

export type Cell = readonly [r: number, c: number]

export function shapeFromCells(cells: readonly Cell[]): Shape {
  const minR = Math.min(...cells.map(([r]) => r))
  const minC = Math.min(...cells.map(([, c]) => c))
  const norm = cells.map(([r, c]) => [r - minR, c - minC] as const)
  const h = Math.max(...norm.map(([r]) => r)) + 1
  const w = Math.max(...norm.map(([, c]) => c)) + 1
  const rows = new Array(h).fill(0)
  for (const [r, c] of norm) rows[r] |= 1 << c
  return { w, h, rows, cells: norm.length, key: `${w}x${h}:${rows.join(',')}` }
}

export function shapeCells(s: Shape): Cell[] {
  const out: Cell[] = []
  for (let r = 0; r < s.h; r++) for (let c = 0; c < s.w; c++) if ((s.rows[r] >> c) & 1) out.push([r, c])
  return out
}

/** 시계 방향 90도 회전 */
export const rotateCW = (s: Shape) => shapeFromCells(shapeCells(s).map(([r, c]) => [c, s.h - 1 - r] as const))
/** 좌우 반전 */
export const mirror = (s: Shape) => shapeFromCells(shapeCells(s).map(([r, c]) => [r, s.w - 1 - c] as const))

export interface Orientation {
  shape: Shape
  /** 지금 화면에 보이는 모양에서 이 모양을 만드는 버튼 조작. 반전을 먼저 누르고 회전을 누른다고 본다 */
  flip: boolean
  rot: number
}

/** 회전 4가지 × 반전 2가지 중 겹치는 것을 빼고 남는 방향들. 조작 횟수가 적은 순서로 */
export function orientations(base: Shape): Orientation[] {
  const seen = new Map<string, Orientation>()
  for (const flip of [false, true]) {
    let s = flip ? mirror(base) : base
    for (let rot = 0; rot < 4; rot++) {
      const prev = seen.get(s.key)
      if (!prev || flip === false && prev.flip) seen.set(s.key, { shape: s, flip, rot })
      s = rotateCW(s)
    }
  }
  return [...seen.values()].sort((a, b) => (+a.flip + a.rot) - (+b.flip + b.rot))
}

/** 모양이 회전·반전으로 서로 같은지 (조각 목록에서 같은 조각을 찾을 때) */
export function canonicalKey(s: Shape): string {
  return orientations(s).map((o) => o.shape.key).sort()[0]
}

// ─── 놓기 ────────────────────────────────────────────────────────────────

export function canPlace(b: Board, s: Shape, r: number, c: number): boolean {
  if (r < 0 || c < 0 || r + s.h > ROWS || c + s.w > COLS) return false
  for (let i = 0; i < s.h; i++) if (b[r + i] & (s.rows[i] << c)) return false
  return true
}

export interface PlaceResult {
  board: Board
  cleared: number[]
  /** 이번 배치로 얻은 점수 (칸 수 + 줄 제거 + 능력 획득) */
  gained: number
  icons: Icon[]
  abilities: IconKind[]
}

/**
 * 조각을 놓고 꽉 찬 줄을 지운다. canPlace를 먼저 확인했다고 본다.
 * heldAbilities는 지금 들고 있는 능력 수. 7개면 아이콘 줄을 지워도 얻지 못하고 아이콘이 남는다.
 */
export function place(b: Board, s: Shape, r: number, c: number, icons: Icon[] = [], heldAbilities = 0): PlaceResult {
  const board = b.slice()
  for (let i = 0; i < s.h; i++) board[r + i] |= s.rows[i] << c
  const cleared: number[] = []
  for (let i = 0; i < s.h; i++) if (board[r + i] === FULL_ROW) cleared.push(r + i)
  let gained = s.cells + lineScore(cleared.length)
  const abilities: IconKind[] = []
  let left = icons
  if (cleared.length) {
    for (const row of cleared) board[row] = 0
    left = []
    for (const ic of icons) {
      if (cleared.includes(ic.r) && heldAbilities + abilities.length < ABILITY_CAP) {
        abilities.push(ic.kind)
        gained += ABILITY_SCORE
      } else left.push(ic)
    }
  }
  return { board, cleared, gained, icons: left, abilities }
}

/** 놓을 수 있는 모든 자리 */
export function placements(b: Board, s: Shape): [r: number, c: number][] {
  const out: [number, number][] = []
  for (let r = 0; r + s.h <= ROWS; r++) for (let c = 0; c + s.w <= COLS; c++) if (canPlace(b, s, r, c)) out.push([r, c])
  return out
}

export function anyPlacement(b: Board, s: Shape): boolean {
  for (let r = 0; r + s.h <= ROWS; r++) for (let c = 0; c + s.w <= COLS; c++) if (canPlace(b, s, r, c)) return true
  return false
}

/** 테스트와 디버깅용: '#'은 찬 칸, '.'은 빈 칸 */
export function parseBoard(text: string): Board {
  const lines = text.trim().split('\n').map((l) => l.trim())
  const b = emptyBoard()
  const off = ROWS - lines.length
  lines.forEach((line, i) => { for (let c = 0; c < COLS; c++) if (line[c] === '#') b[off + i] |= 1 << c })
  return b
}

export function printBoard(b: Board): string {
  return b.map((row) => Array.from({ length: COLS }, (_, c) => ((row >> c) & 1 ? '#' : '.')).join('')).join('\n')
}

export function parseShape(text: string): Shape {
  const cells: Cell[] = []
  text.trim().split('\n').forEach((line, r) => [...line.trim()].forEach((ch, c) => { if (ch === '#') cells.push([r, c]) }))
  return shapeFromCells(cells)
}
