/**
 * 추천 엔진.
 *
 * 손에 든 조각(최대 3개)을 놓는 순서 × 회전·반전 × 위치를 빔 탐색으로 훑는다.
 * 놓을 때마다 줄이 지워질 수 있어서 순서가 결과를 바꾼다.
 *
 * 평가는 두 단계다.
 *  1) 빠른 평가: 매 단계 수십만 번 부르므로 판 모양만 싸게 본다
 *     (막힌 작은 빈칸, 줄별 채움, 줄 안의 빈칸 조각남)
 *  2) 마지막 평가: 살아남은 후보 몇십 개만 다음 세트를 생각해서 다시 본다.
 *     19종 조각이 각각 몇 군데에 들어가는지 세어 '다음 세트에 못 놓을 확률'을 어림한다.
 */

import {
  type Board, type Icon, type Shape, COLS, ROWS, FULL_ROW, ABILITY_CAP, ABILITY_SCORE,
  boardKey, lineScore, orientations, popcount, place,
} from './board'
import { PIECES, PIECE_ORIENTS } from './pieces'

export interface SolveInput {
  board: Board
  icons: Icon[]
  /** 카드 순서대로. 이미 놓은 카드는 null */
  hand: (Shape | null)[]
  heldAbilities: number
  /** 들고 있는 바꿔 뽑기·점 찍기 수 (다 못 놓을 때 어느 능력을 어디에 쓸지 고르는 데 쓴다) */
  swaps?: number
  dots?: number
  /** 조각 id → 등장 확률 */
  weights: Map<number, number>
  /** 0 = 안전 위주, 1 = 점수 위주 */
  style: number
  /** 빔 너비. 기본 160 (시뮬레이션에서 줄여 쓴다) */
  beam?: number
  /** 계산에 쓸 시간(ms). 남는 시간은 다음 세트를 가상으로 놓아 보는 데 쓴다. 0이면 그 단계를 건너뛴다 */
  budgetMs?: number
}

export interface SolveOptions {
  onProgress?: (fraction: number) => void
  now?: () => number
}

export interface Step {
  slot: number
  /** 놓을 모양(회전·반전을 마친 뒤) */
  shape: Shape
  flip: boolean
  rot: number
  r: number
  c: number
  cleared: number[]
  gained: number
  abilities: number
  boardAfter: Board
  iconsAfter: Icon[]
}

export interface Plan {
  steps: Step[]
  /** 이 세트에서 얻는 점수 */
  gained: number
  /** 정렬 기준 */
  value: number
  /** 다음 세트에서 못 놓는 조각이 나올 확률 어림 (0~1) */
  risk: number
  /** 어떤 조각으로도 메우기 어려운 빈칸 수 */
  stuck: number
  /** 손의 조각을 다 놓지 못하는 계획 */
  incomplete: boolean
  board: Board
  /** 이 계획으로 얻는 능력의 값어치(정렬용) */
  abilityValue: number
  /** 다음 세트 가상 플레이 횟수 (0이면 안 했다) */
  samples: number
}

interface State {
  board: Board
  icons: Icon[]
  used: number
  gained: number
  held: number
  steps: Step[]
  quick: number
  /** 이 계획에서 쓴 점 찍기 수 */
  dotsUsed: number
  /** 쓴 점 찍기의 비용 합 (위기용 여분에 손대면 비싸다) */
  dotCost: number
  /** 이 판의 큰 제거 잠재력 보너스 (quick에 이미 더해져 있다). 자식 후보를 추릴 때 어림값으로 쓴다 */
  pot: number
  /** 이 계획까지 들고 있는 바꿔 뽑기·점 찍기 수 (얻은 것 포함) */
  sw: number
  dt: number
  /** 이 계획에서 얻은 능력들의 가치 합 (iconWorth) */
  abilValue: number
}

/** slot -1이면 점 찍기 */
interface Cand { pi: number; slot: number; oi: number; r: number; c: number; quick: number }

const DOT_SHAPE: Shape = { w: 1, h: 1, rows: [1], cells: 1, key: '1x1:1' }

/**
 * 아이콘 줄을 지워 능력을 얻는 배치에 얹는 가중치 (게임 점수가 아니다). 능력의 진짜 값어치는 그걸로 뭘 하느냐에서
 * 나오고 그건 계획 안의 점 찍기 단계·잠재력이 따로 계산한다. 여기서는 '위기에서 판을 살릴 여분'만 친다:
 * 하나도 없으면 900, 많이 들고 있으면 400 (사용자 지적 2026-10-03: 들고만 있는 능력이 900점일 리 없다.
 * 250까지 내렸더니 아이콘 줄을 안 챙겨 후반에 능력이 말라 죽었다 → 400. 가상 플레이에서는 250과 차이 없음, 실제 판 지적으로 올림)
 */
const abilityWorth = (held: number) => Math.max(ADV.abilFloor, 900 - ADV.abilSlope * held)

/**
 * 아이콘 하나를 얻는 가치 (docs/SCORE-CYCLE.md 4절). 점 찍기는 "1칸 모자란 줄을 2줄로" 바꿔 +900을 내는 열쇠라
 * 적게 들고 있을수록 900에 가깝고, 바꿔 뽑기는 생명 보험이라 3개면 충분하다. 7개면 더 못 얻는다
 */
function iconWorth(kind: Icon['kind'], sw: number, dt: number): number {
  if (sw + dt >= ABILITY_CAP) return 0
  return kind === 'dot' ? (dt < 2 ? ADV.dotWorth : ADV.dotWorthMany) : (sw < 3 ? ADV.swapWorth : ADV.swapWorthMany)
}

/** 테스트 진단용 훅 */
export const DEBUG: { onBeam: null | ((depth: number, beam: State[], prelim: number) => void) } = { onBeam: null }

const BEAM = 160
const FINAL = 48
/** 다음 세트 가상 플레이를 받는 후보 수 */
const ROLLOUT_CANDIDATES = 12
/** 가상 플레이 안에서 쓰는 작은 빔 */
const ROLLOUT_BEAM = 8

// ─── 빠른 평가 ───────────────────────────────────────────────────────────

/**
 * 고립된 빈칸을 비트 연산으로 센다. 칸마다 상하좌우 빈 이웃 수를 구해서
 *   이웃 0개        → 1칸짜리 구멍 (1칸 조각이나 점 찍기로만 메운다)
 *   서로만 이웃인 두 칸 → 2칸짜리 구멍 (2칸 조각은 없다)
 *   이웃 1개(막다른 칸) → 메우기 까다로운 칸
 * 덩어리를 BFS로 따라가는 것보다 열 배쯤 빠르다. 탐색 중 수십만 번 부른다.
 */
function pockets(b: Board): [p1: number, p2: number, deadEnd: number] {
  let p1 = 0, p2 = 0, dead = 0
  let prevOne = 0
  for (let r = 0; r < ROWS; r++) {
    const e = ~b[r] & FULL_ROW
    const up = r > 0 ? ~b[r - 1] & FULL_ROW : 0
    const down = r < ROWS - 1 ? ~b[r + 1] & FULL_ROW : 0
    const L = (e << 1) & FULL_ROW // c-1이 비었다
    const R = e >> 1 // c+1이 비었다
    const any = L | R | up | down
    const two = (L & R) | (L & up) | (L & down) | (R & up) | (R & down) | (up & down)
    const one = e & any & ~two
    p1 += popcount(e & ~any)
    p2 += 2 * popcount(one & R & (one >> 1))
    p2 += 2 * popcount(one & prevOne & up)
    dead += popcount(one)
    prevOne = one
  }
  return [p1, p2, dead - p2]
}

/**
 * 예비 공간 규칙 (docs/SCORE-CYCLE.md 3절): 어떤 순간에도 가장 큰 조각이 들어갈 자리가 있어야 한다.
 * 빈 3×4 또는 4×3 창 하나와, 빈 1×5 또는 5×1 띠 하나
 */
function reserveOk(b: Board): boolean {
  let win = false, strip = false
  for (let r = 0; r < ROWS && !(win && strip); r++) {
    const e0 = ~b[r] & FULL_ROW
    if (!strip && e0 & (e0 >> 1) & (e0 >> 2) & (e0 >> 3) & (e0 >> 4)) strip = true
    if (!strip && r + 5 <= ROWS && e0 & ~b[r + 1] & ~b[r + 2] & ~b[r + 3] & ~b[r + 4] & FULL_ROW) strip = true
    if (!win && r + 3 <= ROWS) {
      const e3 = e0 & ~b[r + 1] & ~b[r + 2] & FULL_ROW
      if (e3 & (e3 >> 1) & (e3 >> 2) & (e3 >> 3)) win = true
      else if (r + 4 <= ROWS) {
        const e4 = e3 & ~b[r + 3] & FULL_ROW
        if (e4 & (e4 >> 1) & (e4 >> 2)) win = true
      }
    }
  }
  return win && strip
}

/** 묵은 줄: 거의 찼는데(빈칸 ≤ 1) 위아래 줄이 반도 안 차서 2줄로 묶일 짝이 없는 줄. 쌓인 채 방치된 블록이다 */
function staleRows(b: Board): number {
  let n = 0
  for (let r = 0; r < ROWS; r++) {
    const k = popcount(b[r])
    if (k < COLS - 1 || k === COLS) continue
    const up = r > 0 ? popcount(b[r - 1]) : 0, down = r < ROWS - 1 ? popcount(b[r + 1]) : 0
    if (up <= COLS / 2 && down <= COLS / 2) n++
  }
  return n
}

/**
 * 빠른 평가의 가중치. 가상 플레이 튜닝(test/tune.test.ts)으로 고른 값이다.
 * 항목이 늘거나 값을 바꾸면 SIM으로 나빠지지 않았는지 꼭 확인한다.
 */
export const W = {
  /** 줄별 채움² (곧 지울 줄) */
  rowSq: 1.2,
  /** 점수 위주일 때 줄별 채움²에 더하는 몫 */
  rowSqStyle: 0.8,
  /** 줄 안에서 빈칸이 여러 토막 */
  segs: 14,
  /** 위아래 줄과 엇갈린 칸 */
  vTrans: 2.5,
  /** 찬 칸 수 */
  filled: 6,
  /**
   * 1칸짜리 구멍 (점 찍기로만 메울 수 있다). 70이었을 때는 더미 잠재력에 밀려 "구멍은 나중에 점 찍기로 메우지"가 돼
   * 고립된 빈칸을 거리낌 없이 만들었다 (2026-10-03 사용자 지적, 성향 1.0 판 95세트에서 사망).
   * 그렇다고 점 찍기 값(350)까지 올리면 줄을 지우면서 생기는 구멍까지 피하느라 지우지 않게 돼 더 일찍 죽는다
   * (앱 조건 8판: 70 → 109.6세트·105,565 / 150 → 115.6·111,984 / 350 → 107.0·96,991, 다음 세트 가상 플레이 없이는 350이 80세트)
   */
  p1: 150,
  /** 2칸짜리 구멍 (2칸 조각이 없어 점 찍기 둘로만 메운다) */
  p2: 100,
  /** 막다른 빈칸 */
  deadEnd: 6,
  /**
   * 예비 공간 규칙(reserveOk)을 깬 판의 벌점. 설계(docs/SCORE-CYCLE.md 3절)에서는 생존 장치로 넣었지만 가상 플레이에서는
   * 켜는 쪽이 훨씬 나빴다 (앱 조건 8판·성향 0.75: 끔 137.0세트·134,483 / 2,500 125.8·119,825 / 1,000+묵은 줄 끔 89.1·79,272).
   * 조건이 판 중반부터는 거의 못 지켜져 상수 벌점처럼 깔리고, 지키려고 큰 빈 공간을 남기느라 다른 데를 더 높이 쌓는다. 꺼 둔다(0)
   */
  reserve: 0,
  /** 묵은 줄(staleRows) 하나당 벌점. 켜면 134.4 → 137.0세트로 조금 낫다 */
  stale: 120,
  /** 통째로 빈 줄 (큰 조각 자리) */
  emptyRow: 0,
  /** 3×3 빈 공간 수 (ㅁ·ㅇ·ㅈ·ㅊ 자리) */
  win33: 0,
  /** 3×4·4×3 빈 공간 수 (ㅂ·ㅐ·ㅋ·ㅌ 자리) */
  win34: 0,
  /**
   * 연속 제거 준비: 같은 열 한 칸만 빈 줄이 위아래로 이어진 '우물'.
   * 블록이 떨어지지 않는 게임이라 세로 조각(ㅣ 5칸, ㅡ 3칸)을 꽂으면 그 줄들이 한 번에 지워진다.
   * 5줄을 한 번에 지우면 7,500점으로 한 줄씩(1,500점)의 다섯 배라서 점수 위주 플레이의 핵심이다.
   */
  well: 0,
  /** 빈칸 두 칸이 같은 자리인 줄이 이어진 것 (두 줄짜리 조각으로 함께 지울 수 있다) */
  align: 0,
  /**
   * 우물 전용 열(맨 오른쪽)에 쌓인 칸 하나당 벌점. 테트리스의 '우물 비워 두기'처럼
   * 나머지 9칸으로만 줄을 채우게 해서 빈칸이 한 열에 줄 서게 만든다.
   * 지우면서 채우는 건 괜찮다 (지워진 줄의 칸은 남지 않으니 벌점도 없다).
   */
  wellCol: 0,
  /**
   * 큰 단위 제거 준비 (2026-10-03). 실제 16만 점 판에서 2줄 제거는 횟수 15%로 점수 37%를 냈고,
   * 기본 평가는 한 줄이 차면 바로 지워서 2줄 이상이 9%뿐이었다.
   *  near2/near3: 위아래로 붙은 2·3줄이 모두 거의 찼고(빈칸 1~4) 빈칸이 조각 하나 폭(5칸) 안에 모여 있으면
   *               한 조각으로 같이 지울 수 있다. 빈칸이 적을수록 크게 친다
   *  single:      옆줄이 거의 찼는데(빈칸 ≤3) 한 줄만 지우는 배치의 벌점 (같이 지울 수 있었다)
   *  potential:   다음 조각 하나로 2줄 이상 지울 수 있는 자리의 기대 점수(조각 확률 가중)에 곱하는 비율.
   *               마지막 평가와 가상 플레이 끝에서 본다 (빠른 평가에서 쓰기엔 비싸다)
   *
   * 실제 조각 빈도(REAL=1)·성향 0.75로 고른 값 (2026-10-03). 16판 평균 생존 세트 · 점수 · 2줄 이상 비율:
   *   기본                       79.6 · 46,518 ·  9%
   *   potential 1.5 + near2 15   96.1 · 65,805 · 19%
   *   potential 2.5 + near2 20  103.1 · 75,880 · 23%  ← 채택
   *   potential 2.5 + near2 30   77.6 · 57,102 · 28%
   * 앱 조건(빔 160, 미리 보기 200ms, 4판): 기본 117.8 · 78,344 · 15% → 채택값 106.0 · 85,291 · 32% (세트당 665 → 805점)
   * near3·single은 2줄 이상을 더 늘리지만(31%까지) 판이 빨리 차서 생존이 20~30% 줄어 0으로 둔다.
   * potential은 1.2~2.5에서 모두 기본보다 나았고 그 자체로 생존도 늘렸다 (거의 찬 줄을 모아 두면 구멍도 덜 생긴다)
   *
   * 그 뒤 multiPotential을 '다음 조각 하나'가 아니라 '판 여유만큼 기다리는 동안 하나라도 올 확률'로 바꿨다 (값이 커진다).
   * 같은 조건 8판: potential 0.8 → 93.3 · 68,165 · 23% / 1.0 → 88.8 · 64,547 / 1.5 → 100.0 · 73,718 · 24% / 2.5 → 73.3 · 52,802
   * 다시 더미(줄 묶음)별로 따로 쳐서 합치게 바꿨다 (하나만 세면 2줄 자리 하나에 포화돼 더 쌓을 보람이 없었다):
   *   potential 1.0 → 100.3 · 78,424 · 27% (3줄 44번) / 1.5 → 99.6 · 74,997 · 25% / 2.5 → 90.3 · 67,543 · 26%
   * 그 뒤 잠재력을 빔 탐색 중간(빔 폭 2배 후보)에도 붙이고, 남는 점 찍기로 메우는 자리까지 세고, 계획 안 점 찍기 단계를 켰다:
   *   potential 0.6 + planDots → 104.9 · 85,880 · 34% (2줄 269 · 3줄 45 · 4줄 2, 채택) / 0.6 단계 끔 → 101.3 · 82,135
   *   1.0 + planDots → 95.0 · 75,608 / 1.0 단계 끔 → 92.5 · 73,965
   */
  near2: 20,
  near3: 0,
  single: 0,
  potential: 0.6,
}

/** 우물로 비워 둘 열 */
const WELL_COLUMN = COLS - 1

/** 이어진 줄 수별 연속 제거 값어치. 지우는 점수가 n²로 늘어서 이것도 그렇게 늘린다 */
const RUN_VALUE = [0, 0, 1, 3, 6, 10]

function quickEval(b: Board, style: number): number {
  let v = 0, filled = 0, emptyRows = 0
  const rowSq = W.rowSq + style * W.rowSqStyle
  for (let r = 0; r < ROWS; r++) {
    const row = b[r]
    if (!row) { emptyRows++; continue }
    const n = popcount(row)
    filled += n
    // 꽉 찬 줄에 가까운 줄일수록 좋다 (곧 지울 수 있다). 점수 위주면 더 크게 본다
    v += n * n * rowSq
    // 줄 안에서 빈칸이 여러 토막이면 한 조각으로 메우기 어렵다
    const empty = ~row & FULL_ROW
    const segs = popcount(empty & ~(empty << 1) & FULL_ROW)
    v -= (segs > 1 ? segs - 1 : 0) * W.segs
  }
  for (let r = 1; r < ROWS; r++) v -= popcount((b[r] ^ b[r - 1]) & FULL_ROW) * W.vTrans
  v -= filled * W.filled
  if (W.near2 || W.near3) v += nearStacks(b) * scoreMul(style)
  const [p1, p2, deadEnd] = pockets(b)
  v -= p1 * W.p1 + p2 * W.p2 + deadEnd * W.deadEnd
  if (W.reserve && !reserveOk(b)) v -= W.reserve
  if (W.stale) v -= staleRows(b) * W.stale
  if (W.emptyRow) v += emptyRows * W.emptyRow
  if (W.win33 || W.win34) {
    // 세 줄씩 묶어 빈칸이 겹치는 열을 구하고, 그 안에서 가로로 3·4칸 이어진 자리를 센다
    let w33 = 0, w34 = 0
    for (let r = 0; r + 3 <= ROWS; r++) {
      const v3 = ~(b[r] | b[r + 1] | b[r + 2]) & FULL_ROW
      if (!v3) continue
      const h3 = v3 & (v3 >> 1) & (v3 >> 2)
      w33 += popcount(h3)
      w34 += popcount(h3 & (v3 >> 3))
      if (r + 4 <= ROWS) w34 += popcount(h3 & ~b[r + 3] & ~(b[r + 3] >> 1) & ~(b[r + 3] >> 2) & FULL_ROW)
    }
    // 한두 군데만 있어도 큰 조각은 들어간다. 많을수록 덜 중요해지게 제곱근으로
    v += Math.sqrt(w33) * W.win33 + Math.sqrt(w34) * W.win34
  }
  if (W.wellCol) {
    let n = 0
    for (let r = 0; r < ROWS; r++) n += (b[r] >> WELL_COLUMN) & 1
    v -= n * W.wellCol
  }
  if (W.well || W.align) {
    // 빈칸 모양이 같은 줄이 위아래로 몇 줄 이어지는지 센다 (빈칸 1칸 → 우물, 2칸 → 정렬)
    let r = 0
    while (r < ROWS) {
      const e = ~b[r] & FULL_ROW
      const n = popcount(e)
      if (n === 0 || n > 2) { r++; continue }
      let len = 1
      while (r + len < ROWS && (~b[r + len] & FULL_ROW) === e) len++
      const val = RUN_VALUE[Math.min(len, 5)] + (len > 5 ? len - 5 : 0)
      v += val * (n === 1 ? W.well : W.align)
      r += len
    }
  }
  return v
}

// ─── 마지막 평가: 다음 세트 ─────────────────────────────────────────────

/** 조각 하나가 들어갈 수 있는 자리 수 (모든 방향 합) */
function fitCount(b: Board, shapes: Shape[], cap: number): number {
  let n = 0
  for (const s of shapes) {
    for (let r = 0; r + s.h <= ROWS; r++) {
      for (let c = 0; c + s.w <= COLS; c++) {
        let ok = true
        for (let i = 0; i < s.h; i++) if (b[r + i] & (s.rows[i] << c)) { ok = false; break }
        if (ok && ++n >= cap) return n
      }
    }
  }
  return n
}

/** 1칸짜리를 빼고 어떤 조각으로도 덮을 수 없는 빈칸 수 */
function stuckCells(b: Board): number {
  const covered = new Array(ROWS).fill(0)
  for (const p of PIECES) {
    if (p.shape.cells === 1) continue
    for (const s of PIECE_ORIENTS.get(p.id)!) {
      for (let r = 0; r + s.h <= ROWS; r++) for (let c = 0; c + s.w <= COLS; c++) {
        let ok = true
        for (let i = 0; i < s.h; i++) if (b[r + i] & (s.rows[i] << c)) { ok = false; break }
        if (ok) for (let i = 0; i < s.h; i++) covered[r + i] |= s.rows[i] << c
      }
    }
  }
  let n = 0
  for (let r = 0; r < ROWS; r++) n += popcount(~(b[r] | covered[r]) & FULL_ROW)
  return n
}

export interface Outlook { risk: number; flex: number; stuck: number; noFit: number[] }

export function outlook(b: Board, weights: Map<number, number>): Outlook {
  let pNoFit = 0, flex = 0
  const noFit: number[] = []
  for (const p of PIECES) {
    const w = weights.get(p.id) ?? 0
    const n = fitCount(b, PIECE_ORIENTS.get(p.id)!, 24)
    if (n === 0) { pNoFit += w; noFit.push(p.id) }
    flex += w * Math.min(n, 24) / 24
  }
  // 세 개 중 하나라도 못 놓는 조각이 나올 확률. 앞 조각으로 줄을 지워 자리가 날 수도 있어서 실제보다 조금 비관적이다
  const risk = 1 - (1 - pNoFit) ** 3
  return { risk, flex, stuck: stuckCells(b), noFit }
}

function finalEval(st: State, inp: SolveInput, remaining: number): { value: number; o: Outlook } {
  const o = outlook(st.board, inp.weights)
  const danger = ADV.dangerBase + (1 - inp.style) * ADV.dangerStyle
  let value = st.gained + quickEval(st.board, inp.style) + o.flex * 600 - o.risk * danger - o.stuck * 120
  if (W.potential) value += W.potential * scoreMul(inp.style) * multiPotential(st.board, inp.weights, spareDotsAfter(inp, st.dotsUsed))
  // 다 못 놓은 조각이 있으면 그 판은 끝난다
  value -= remaining * 100000
  return { value, o }
}

// ─── 탐색 ────────────────────────────────────────────────────────────────

function searchPlans(inp: SolveInput, topN: number): Plan[] {
  const slots = inp.hand.map((s, i) => [i, s] as const).filter((x): x is readonly [number, Shape] => x[1] !== null)
  const orients = new Map(slots.map(([i, s]) => [i, orientations(s)]))
  const start: State = {
    board: inp.board, icons: inp.icons, used: 0, gained: 0, held: inp.heldAbilities, steps: [], quick: 0, dotsUsed: 0, dotCost: 0, pot: 0,
    sw: inp.swaps ?? Math.max(0, inp.heldAbilities - (inp.dots ?? 0)), dt: inp.dots ?? 0, abilValue: 0,
  }
  if (W.potential) start.pot = W.potential * scoreMul(inp.style) * multiPotential(inp.board, inp.weights, spareDotsAfter(inp, 0))
  const allUsed = slots.reduce((m, [i]) => m | (1 << i), 0)
  // 점 찍기를 넉넉히 들고 있으면(위기용 keepDots개는 남기고) 계획 안에 점 찍기 단계를 넣는다.
  // 전에는 능력을 '막혔을 때 살리기'로만 써서, 점 찍기 5개를 쥐고도 두 칸 메워 큰 제거 자리를 만드는 수를 못 봤다 (2026-10-03 사용자 지적)
  // 위기용 여분(keepDots)까지 다 후보에 넣되, 여분에 손대는 점 찍기는 비용을 높게 매긴다 (dotStepCost).
  // 전에는 여분은 아예 안 썼는데, 점 찍기 하나로 ㅡ가 2줄에서 3줄이 되는(+1,500) 판에서도 못 썼다 (2026-10-03 사용자 지적)
  const dotBudget = ADV.planDots ? Math.max(0, Math.min(ADV.planDotsMax, inp.dots ?? 0)) : 0
  const dotOrient = { shape: DOT_SHAPE, flip: false, rot: 0 }

  let beam: State[] = [start]
  const finished: State[] = []
  for (let depth = 0; depth < slots.length + dotBudget; depth++) {
    // 자식 판은 수십만 개가 나온다. 먼저 가벼운 기록만 남기고, 빔에 들어간 것만 실제 상태로 만든다
    const best = new Map<string, Cand>()
    const scratch = new Array<number>(ROWS)
    beam.forEach((st, pi) => {
      let expanded = false
      // 조각을 다 놓은 계획은 그 자체로 답이 될 수 있다 (점 찍기를 더 쓰는 건 선택이다)
      if (st.used === allUsed) finished.push(st)
      const tryPlace = (slot: number, s: Shape, oi: number, r: number, c: number, cost: number) => {
        for (let i = 0; i < s.h; i++) if (st.board[r + i] & (s.rows[i] << c)) return
        expanded = true
        for (let k = 0; k < ROWS; k++) scratch[k] = st.board[k]
        let lines = 0, clearedMask = 0
        for (let i = 0; i < s.h; i++) {
          scratch[r + i] |= s.rows[i] << c
          if (scratch[r + i] === FULL_ROW) { lines++; clearedMask |= 1 << (r + i) }
        }
        let got = 0, gotWorth = 0, sw = st.sw, dt = st.dt
        if (lines) {
          for (let k = 0; k < ROWS; k++) if (clearedMask & (1 << k)) scratch[k] = 0
          for (const ic of st.icons) if (clearedMask & (1 << ic.r) && sw + dt < ABILITY_CAP) { got++; gotWorth += iconWorth(ic.kind, sw, dt); if (ic.kind === 'dot') dt++; else sw++ }
        }
        const gained = s.cells + lineScore(lines) + got * ABILITY_SCORE
        // 부모의 잠재력 보너스를 자식의 어림값으로 얹는다. 잠재력은 추린 뒤에만 제대로 계산하는데, 그 전 순위가 빠른 평가만이면
        // 한 줄 지우는 +300이 더미를 지키는 자리들을 전부 밀어내 잠재력을 볼 기회조차 없었다 (2026-10-03: stack5 판에서 5줄 더미를 깨고 한 줄을 털었다)
        let quick = st.gained + gained + st.abilValue + gotWorth + quickEval(scratch, inp.style) - cost + (ADV.parentPot ? st.pot : 0)
        if (W.single && lines === 1) quick -= singlePenalty(st.board, clearedMask) * scoreMul(inp.style)
        const key = boardKey(scratch) + (slot < 0 ? st.used : st.used | (1 << slot))
        const prev = best.get(key)
        if (!prev || prev.quick < quick) best.set(key, { pi, slot, oi, r, c, quick })
      }
      for (const [slot] of slots) {
        if (st.used & (1 << slot)) continue
        orients.get(slot)!.forEach((o, oi) => {
          const s = o.shape
          for (let r = 0; r + s.h <= ROWS; r++) for (let c = 0; c + s.w <= COLS; c++) tryPlace(slot, s, oi, r, c, 0)
        })
      }
      if (st.dotsUsed < dotBudget) {
        // 점 찍기는 거의 찬 줄(채움 ≥ planDotRowMin)의 빈칸에만 (그 밖은 조각으로 메우는 게 낫다). 쓴 점 찍기마다 비용을 뺀다
        const cost = dotStepCost(inp, st.dotsUsed)
        for (let r = 0; r < ROWS; r++) {
          if (popcount(st.board[r]) < ADV.planDotRowMin) continue
          for (let c = 0; c < COLS; c++) if (!((st.board[r] >> c) & 1)) tryPlace(-1, DOT_SHAPE, 0, r, c, cost)
        }
      }
      if (!expanded) finished.push(st)
    })
    if (!best.size) break
    const width = inp.beam ?? BEAM
    // 빠른 평가로 빔 폭의 두 배까지 추린 뒤, 그 후보들에는 큰 제거 잠재력을 붙여 다시 순위를 매긴다.
    // 잠재력을 마지막 평가에서만 보면 더미를 쌓아 가는 중간 단계(점 찍기 하나, 조각 하나)가 빠른 평가에서
    // 비용으로만 보여 일찍 잘려 나간다 (2026-10-03 사용자 지적: 5줄 더미를 만들 수 있는데 한 줄을 털었다)
    const all = [...best.values()].sort((a, b) => b.quick - a.quick)
    const take = W.potential ? width * 2 : width
    let prelim: Cand[]
    if (ADV.perParent > 0 || ADV.parentCap > 0) {
      // 부모마다 자식을 최소 perParent개는 넣고(다양성), 최대 parentCap개까지만 넣는다(한 부모의 변주가 빔을 점령하지 않게)
      const used = new Map<number, number>()
      prelim = []
      const picked = new Set<Cand>()
      if (ADV.perParent > 0) for (const cd of all) {
        const k = used.get(cd.pi) ?? 0
        if (k < ADV.perParent) { used.set(cd.pi, k + 1); prelim.push(cd); picked.add(cd) }
      }
      for (const cd of all) {
        if (prelim.length >= take) break
        if (picked.has(cd)) continue
        const k = used.get(cd.pi) ?? 0
        if (ADV.parentCap > 0 && k >= ADV.parentCap) continue
        used.set(cd.pi, k + 1); prelim.push(cd)
      }
    } else prelim = all.slice(0, take)
    const children = prelim.map((cd) => {
      const o = cd.slot < 0 ? dotOrient : orients.get(cd.slot)![cd.oi]
      const child = expand(beam[cd.pi], cd.slot, o.flip, o.rot, o.shape, cd.r, cd.c, inp)
      if (W.potential) {
        child.pot = W.potential * scoreMul(inp.style) * multiPotential(child.board, inp.weights, spareDotsAfter(inp, child.dotsUsed))
        child.quick += child.pot
      }
      return child
    })
    beam = children.sort((a, b) => b.quick - a.quick).slice(0, width)
    DEBUG.onBeam?.(depth, beam, prelim.length)
  }
  // 조각을 다 놓은 계획들 (마지막 빔 + 도중에 다 놓고 끝낸 것). 같은 걸 두 번 넣지 않는다
  const seenDone = new Set<State>()
  const complete = [...beam, ...finished].filter((s) => s.used === allUsed && !seenDone.has(s) && seenDone.add(s))
  const pool = complete.length ? complete.sort((a, b) => b.quick - a.quick) : [...beam, ...finished].sort((a, b) => b.steps.length - a.steps.length || b.quick - a.quick)

  const scored = pool.slice(0, FINAL).map((st) => {
    const { value, o } = finalEval(st, inp, slots.length - st.steps.filter((x) => x.slot >= 0).length)
    return {
      steps: st.steps, gained: st.gained, value, risk: o.risk, stuck: o.stuck,
      incomplete: st.steps.filter((x) => x.slot >= 0).length < slots.length, board: st.board,
      abilityValue: st.abilValue, samples: 0,
    } satisfies Plan
  })
  scored.sort((a, b) => b.value - a.value)

  // 같은 자리 조합을 순서만 바꾼 계획은 하나만 남긴다
  const out: Plan[] = []
  const keys = new Set<string>()
  for (const p of scored) {
    const k = p.steps.map((s) => `${s.slot}:${s.shape.key}@${s.r},${s.c}`).sort().join('|')
    if (keys.has(k)) continue
    keys.add(k)
    out.push(p)
    if (out.length >= topN) break
  }
  return out
}

function expand(st: State, slot: number, flip: boolean, rot: number, s: Shape, r: number, c: number, inp: SolveInput): State {
  const style = inp.style
  const board = st.board.slice()
  const cleared: number[] = []
  for (let i = 0; i < s.h; i++) {
    board[r + i] |= s.rows[i] << c
    if (board[r + i] === FULL_ROW) cleared.push(r + i)
  }
  let gained = s.cells + lineScore(cleared.length)
  let icons = st.icons
  let got = 0, gotWorth = 0, sw = st.sw, dt = st.dt
  if (cleared.length) {
    for (const row of cleared) board[row] = 0
    if (icons.length) {
      const left: Icon[] = []
      for (const ic of icons) {
        if (cleared.includes(ic.r) && sw + dt < ABILITY_CAP) { got++; gained += ABILITY_SCORE; gotWorth += iconWorth(ic.kind, sw, dt); if (ic.kind === 'dot') dt++; else sw++ } else left.push(ic)
      }
      icons = left
    }
  }
  const step: Step = { slot, shape: s, flip, rot, r, c, cleared, gained, abilities: got, boardAfter: board, iconsAfter: icons }
  const total = st.gained + gained
  const abilValue = st.abilValue + gotWorth
  const dotsUsed = st.dotsUsed + (slot < 0 ? 1 : 0)
  // 쓴 점 찍기의 비용 합
  const dotCost = st.dotCost + (slot < 0 ? dotStepCost(inp, st.dotsUsed) : 0)
  return {
    board, icons, used: slot < 0 ? st.used : st.used | (1 << slot), gained: total, held: st.held + got, dotsUsed, dotCost, pot: 0,
    sw, dt: slot < 0 ? dt - 1 : dt, abilValue,
    steps: [...st.steps, step],
    quick: total + abilValue + quickEval(board, style) - dotCost - (W.single && cleared.length === 1 ? singlePenalty(st.board, 1 << cleared[0]) * scoreMul(style) : 0),
  }
}

// ─── 시간 안에서 최선: 다음 세트 가상 플레이 ─────────────────────────────

/**
 * 1) 빔 탐색으로 후보 계획들을 뽑고
 * 2) 남은 시간 동안 상위 후보마다 다음 세트를 같은 표본으로 여러 번 뽑아 실제로 놓아 본다.
 *    다음 세트를 못 놓는 표본이 많은 후보는 크게 깎이고, 다음 세트에서 줄을 많이 지울 수
 *    있는 후보는 올라간다. 모든 후보가 같은 표본을 쓰므로 운이 아니라 판 모양의 차이가 드러난다.
 * 같은 입력이면 같은 표본(판에서 정한 씨앗)을 쓰므로 언제나 같은 답이 나온다.
 */
export function solve(inp: SolveInput, topN = 5, opts: SolveOptions = {}): Plan[] {
  const now = opts.now ?? (() => performance.now())
  const t0 = now()
  const budget = inp.budgetMs ?? 0
  const plans = searchPlans(inp, Math.max(topN, budget > 0 ? ROLLOUT_CANDIDATES : topN))
  opts.onProgress?.(budget > 0 ? Math.min(0.35, (now() - t0) / budget) : 1)
  if (budget <= 0 || plans.length < 2 || plans[0].incomplete) return plans.slice(0, topN)

  const cands = plans.filter((p) => !p.incomplete).slice(0, ROLLOUT_CANDIDATES)
  const rand = rng(hashBoard(inp.board) ^ 0x9e3779b9)
  const table = weightTable(inp.weights)
  const sums = new Float64Array(cands.length)
  const deaths = new Int32Array(cands.length)
  let samples = 0
  const deadline = t0 + budget
  // 최소 몇 판은 돌려야 평균이 의미가 있다. 시간이 남으면 더 돌린다
  while (samples < 64 && (samples < 6 || now() < deadline)) {
    const set = [pick(table, rand), pick(table, rand), pick(table, rand)]
    cands.forEach((p, i) => {
      const r = rollout(p.board, set, inp.style, inp.weights, spareDotsAfter(inp, p.steps.filter((s) => s.slot < 0).length))
      if (r === null) deaths[i]++
      else sums[i] += r
    })
    samples++
    opts.onProgress?.(Math.min(0.99, 0.35 + 0.65 * (now() - t0) / budget))
  }
  // 죽는 표본은 크게 깎는다. 능력이 있으면 한 번은 버틸 수 있어서 덜 깎는다
  const deathCost = (inp.heldAbilities > 0 ? ADV.deathHeld : ADV.deathNone) * (1.2 - inp.style * 0.4)
  const scored = cands.map((p, i) => {
    const alive = samples - deaths[i]
    const mean = (sums[i] - deaths[i] * deathCost) / samples
    // 어떤 조각으로도 못 덮는 빈칸(stuck)은 점 찍기로만 메우니 하나당 점 찍기 값만큼 깎는다. 전에는 탐색 단계의 평가(finalEval)에만
    // 있어서 후보 12개 중에서 고를 때는 이번 세트 + 다음 세트 점수만 봤고, 구멍이 세트마다 하나씩 조용히 쌓였다 (2026-10-04, 로직.png)
    return { p, v: p.gained + p.abilityValue + mean - p.stuck * ADV.stuckCost, risk: deaths[i] / samples, alive }
  })
  // 생존이 1순위 (docs/SCORE-CYCLE.md 5절): 같은 표본으로 돌렸으니 죽는 표본이 적은 계획이 무조건 앞. 같을 때만 점수로 가른다.
  // 전에는 벌점이라 큰 더미의 기대 점수가 사망 위험을 덮었다
  if (ADV.survivalFirst) scored.sort((a, b) => (samples - a.alive) - (samples - b.alive) || b.v - a.v)
  else scored.sort((a, b) => b.v - a.v)
  opts.onProgress?.(1)
  return scored.slice(0, topN).map(({ p, v, risk }) => ({ ...p, value: v, risk, samples }))
}

/** 판 위에서 세 조각을 작은 빔으로 놓아 본다. 다 못 놓으면 null */
/** 계획에서 점 찍기를 dotsUsed개 쓴 뒤에도 남는, 판 짜기에 쓸 수 있는 점 찍기 수 (위기용 keepDots개는 뺀다) */
/** 계획에서 dotsUsed개를 쓴 뒤 하나 더 쓰는 비용. 남는 게 위기용 여분(keepDots)뿐이면 능력 하나의 위기 값어치(900)로 친다 */
function dotStepCost(inp: SolveInput, dotsUsed: number): number {
  const remain = (inp.dots ?? 0) - dotsUsed - 1
  return remain < ADV.keepDots ? abilityWorth(0) : ADV.planDotCost
}

function spareDotsAfter(inp: SolveInput, dotsUsed: number): number {
  return ADV.dotFill ? Math.max(0, Math.min(ADV.planDotsMax, (inp.dots ?? 0) - dotsUsed - ADV.keepDots)) : 0
}

function rollout(board: Board, set: Shape[][], style: number, weights: Map<number, number>, spareDots = 0): number | null {
  interface S { b: number[]; used: number; gained: number; q: number }
  let beam: S[] = [{ b: board, used: 0, gained: 0, q: 0 }]
  const scratch = new Array<number>(ROWS)
  for (let depth = 0; depth < 3; depth++) {
    const next: S[] = []
    for (const st of beam) {
      for (let k = 0; k < 3; k++) {
        if (st.used & (1 << k)) continue
        for (const s of set[k]) {
          for (let r = 0; r + s.h <= ROWS; r++) for (let c = 0; c + s.w <= COLS; c++) {
            let ok = true
            for (let i = 0; i < s.h; i++) if (st.b[r + i] & (s.rows[i] << c)) { ok = false; break }
            if (!ok) continue
            for (let i = 0; i < ROWS; i++) scratch[i] = st.b[i]
            let lines = 0
            for (let i = 0; i < s.h; i++) {
              scratch[r + i] |= s.rows[i] << c
              if (scratch[r + i] === FULL_ROW) lines++
            }
            if (lines) for (let i = 0; i < s.h; i++) if (scratch[r + i] === FULL_ROW) scratch[r + i] = 0
            const gained = st.gained + s.cells + lineScore(lines)
            const q = gained + quickEval(scratch, style)
            if (next.length < ROLLOUT_BEAM || q > next[next.length - 1].q) {
              const item = { b: scratch.slice(), used: st.used | (1 << k), gained, q }
              // 작은 빔이라 정렬 삽입이 가장 싸다
              let j = next.length
              next.push(item)
              while (j > 0 && next[j - 1].q < q) { next[j] = next[j - 1]; j-- }
              next[j] = item
              if (next.length > ROLLOUT_BEAM) next.pop()
            }
          }
        }
      }
    }
    if (!next.length) return null
    beam = next
  }
  return beam[0].q + (W.potential ? W.potential * scoreMul(style) * multiPotential(beam[0].b, weights, spareDots) : 0)
}

// ─── 큰 단위 제거 ────────────────────────────────────────────────────────

/**
 * 성향(0 안전 ~ 1 점수)에 따라 큰 단위 제거 항목을 얼마나 세게 볼지. 가중치는 성향 0.75(사용자 설정)에서 골랐고
 * 그때 1.0이다. 안전 위주로 내리면 쌓기를 덜 해서 판이 덜 찬다
 */
const scoreMul = (style: number) => 0.4 + 0.8 * style

/** 비트 마스크의 가로 폭 (가장 왼쪽 빈칸부터 가장 오른쪽 빈칸까지) */
function span(mask: number): number {
  if (!mask) return 0
  return 32 - Math.clz32(mask) - (31 - Math.clz32(mask & -mask))
}

/**
 * 위아래로 붙은 2·3줄이 모두 거의 찼고 빈칸이 조각 하나 폭 안에 모여 있는 곳의 값.
 * 빈칸이 적을수록 조각 하나로 메우기 쉬우니 (9 - 빈칸 수)만큼 친다
 */
function nearStacks(b: Board): number {
  let v = 0
  const miss = new Array<number>(ROWS), n = new Array<number>(ROWS)
  for (let r = 0; r < ROWS; r++) { miss[r] = ~b[r] & FULL_ROW; n[r] = popcount(miss[r]) }
  for (let r = 0; r + 1 < ROWS; r++) {
    if (n[r] < 1 || n[r] > 4 || n[r + 1] < 1 || n[r + 1] > 4) continue
    if (span(miss[r] | miss[r + 1]) > 5) continue
    v += W.near2 * (9 - n[r] - n[r + 1])
    if (W.near3 && r + 2 < ROWS && n[r + 2] >= 1 && n[r + 2] <= 3 && n[r] <= 3 && n[r + 1] <= 3 && span(miss[r] | miss[r + 1] | miss[r + 2]) <= 5)
      v += W.near3 * (10 - n[r] - n[r + 1] - n[r + 2])
  }
  return v
}

/** 한 줄만 지우는데 바로 위나 아래 줄이 거의 찼으면(빈칸 ≤3) 같이 지울 수 있었다 */
function singlePenalty(before: Board, clearedMask: number): number {
  const k = 31 - Math.clz32(clearedMask)
  const near = (r: number) => r >= 0 && r < ROWS && r !== k && popcount(~before[r] & FULL_ROW) <= 3 && popcount(~before[r] & FULL_ROW) >= 1
  return near(k - 1) || near(k + 1) ? W.single : 0
}

/**
 * 큰 제거를 준비해 두고 기다릴 수 있는 조각 수. 블록이 안 떨어지는 게임이라 쌓아 둔 줄은 그대로 남지만,
 * 기다리는 동안 다른 조각을 어딘가에 놓아야 하므로 판 여유(빈칸)가 기다릴 수 있는 길이를 정한다.
 * 한 세트에 약 15~19칸을 놓는다. 보수적으로 잡지 않는다: 빈칸이 60개 넘으면 세 세트 이상(12장)까지 기다리고,
 * 정말 한두 세트 안에 막힐 것 같을 때(빈칸 30개 아래)만 한 세트 안팎으로 줄여 지금 터는 쪽이 이기게 한다.
 * 일찍 털면 손해 볼 확률이 높다는 사용자 방침 (2026-10-03). 9장(빈칸/8)으로 줄여 봤더니 앱 조건 8판에서
 * 109.6세트·105,565 → 103.9·99,586으로 나빠져 되돌렸다. 죽을 위험 자체는 마지막 평가의 risk 항목과 다음 세트 가상 플레이가 깎는다
 */
function potentialDraws(b: Board): number {
  let free = 0
  for (let r = 0; r < ROWS; r++) free += COLS - popcount(b[r])
  return Math.max(3, Math.min(ADV.drawsMax, Math.round(free / ADV.drawsDiv)))
}

/**
 * 2줄 이상 한 번에 지울 수 있는 자리의 기대 점수.
 * 조각마다 그 조각 하나로 지울 수 있는 가장 큰 줄 수를 찾고, 앞으로 potentialDraws(판 여유)개 안에 그런 조각이
 * 하나라도 올 확률로 친다: EV = Σ_k lineScore(k) × [P(k줄 이상 되는 조각이 옴) − P(k+1줄 이상)].
 * 전에는 '다음 조각 하나'의 확률만 써서(ㅣ·ㅡ 합쳐 13%) 3줄 준비(2,700)가 350점으로만 보였고, 점 찍기 300점이
 * 그걸 이겨서 쌓아 둔 줄을 깨라고 했다 (2026-10-03 사용자 지적). 두 세트 안에 올 확률(약 56%)로 보면 1,500점이다.
 * 2줄 1,200 · 3줄 2,700 · 4줄 4,800 · 5줄 7,500이라 큰 제거를 준비한 판이 크게 오른다
 */
export function multiPotential(b: Board, weights: Map<number, number>, spareDots = 0): number {
  const n = new Array<number>(ROWS)
  for (let r = 0; r < ROWS; r++) n[r] = popcount(~b[r] & FULL_ROW)
  // 더미(한 번에 지워지는 줄 묶음)마다, 그걸 지울 수 있는 조각들의 확률 합. 조각 하나는 더미 하나에 한 번만 센다.
  // 더미별로 따로 쳐서 합쳐야 더미를 하나 더 만들 때마다 값이 늘어 쌓게 된다
  // (전에는 판 전체에서 하나만 세서 2줄 자리 하나만 있으면 포화돼 더 쌓을 보람이 없었다 — 사용자 지적 2026-10-03).
  // 조각을 놓고도 몇 칸 모자란 줄은 남는 점 찍기(spareDots)로 메워 같이 지울 수 있다. 그 점 찍기 비용은 뺀다.
  // 그래야 "점 찍기로 두 칸 메워 두면 세로 조각 하나로 2줄"인 판을 짤 가치가 보인다
  const groups = new Map<number, { q: number; dots: number }>()
  const miss = new Array<number>(5)
  for (const p of PIECES) {
    const w = weights.get(p.id) ?? 0
    if (!w) continue
    const seen = new Set<number>()
    for (const s of PIECE_ORIENTS.get(p.id)!) {
      if (s.h < 2) continue
      for (let r = 0; r + s.h <= ROWS; r++) {
        // 범위 안에 빈칸 1~5+점 찍기인 줄이 둘은 있어야 2줄을 지운다 (조각 한 줄의 폭은 5칸 이하)
        let near = 0
        for (let i = 0; i < s.h; i++) if (n[r + i] >= 1 && n[r + i] <= 5 + spareDots) near++
        if (near < 2) continue
        for (let c = 0; c + s.w <= COLS; c++) {
          let ok = true, mask = 0, k = 0
          for (let i = 0; i < s.h; i++) {
            const bits = s.rows[i] << c
            if (b[r + i] & bits) { ok = false; break }
            const m = popcount(~(b[r + i] | bits) & FULL_ROW)
            miss[i] = m
            if (m === 0) { mask |= 1 << (r + i); k++ }
          }
          if (!ok) continue
          // 모자란 칸이 적은 줄부터 점 찍기로 메운다
          let dots = 0
          if (spareDots > 0) {
            for (let want = 1; want <= spareDots && dots + want <= spareDots; want++) {
              for (let i = 0; i < s.h; i++) if (miss[i] === want && dots + want <= spareDots) { dots += want; mask |= 1 << (r + i); k++ }
            }
          }
          if (k >= 2 && !seen.has(mask)) {
            seen.add(mask)
            const g = groups.get(mask)
            if (g) { g.q += w; g.dots = Math.min(g.dots, dots) } else groups.set(mask, { q: w, dots })
          }
        }
      }
    }
  }
  if (!groups.size) return 0
  // 값이 큰 더미부터 센다. 이미 센 더미에 포함되는 작은 더미(같은 줄들의 일부)는 또 세지 않는다.
  // 점 찍기는 전체 예산(spareDots)에서 한 번만 쓴다 — 더미마다 따로 다 쓸 수 있는 것처럼 세면
  // 같은 점 찍기 3개를 여러 더미에 거듭 세서 잠재력이 부풀고, 점 찍기를 지금 써서 더미를 키우는 계획이 손해로 보인다
  const draws = potentialDraws(b)
  const valued = [...groups].map(([mask, g]) => {
    // 4줄 이상은 3줄과 같은 값: 높이 쌓아 기다릴 이유를 없앤다 (docs/SCORE-CYCLE.md 2절)
    const prize = lineScore(Math.min(popcount(mask), ADV.stackMax)) - ADV.planDotCost * g.dots
    return { mask, g, prize, ev: prize * (1 - (1 - Math.min(1, g.q)) ** draws) }
  }).filter((x) => x.prize > 0).sort((x, y) => y.ev - x.ev)
  let ev = 0, covered = 0, dotsLeft = spareDots
  for (const x of valued) {
    if ((x.mask & covered) === x.mask || x.g.dots > dotsLeft) continue
    ev += x.ev
    covered |= x.mask
    dotsLeft -= x.g.dots
  }
  return ev
}

type WeightTable = { cum: Float64Array; shapes: Shape[][] }
function weightTable(w: Map<number, number>): WeightTable {
  const shapes: Shape[][] = [], cum: number[] = []
  let acc = 0
  for (const p of PIECES) {
    const x = w.get(p.id) ?? 0
    if (x <= 0) continue
    acc += x
    cum.push(acc)
    shapes.push(PIECE_ORIENTS.get(p.id)!)
  }
  return { cum: Float64Array.from(cum.map((c) => c / acc)), shapes }
}
function pick(t: WeightTable, rand: () => number): Shape[] {
  const x = rand()
  let i = 0
  while (i < t.cum.length - 1 && t.cum[i] < x) i++
  return t.shapes[i]
}
export function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32 }
}
function hashBoard(b: Board): number {
  let h = 2166136261
  for (const row of b) { h ^= row; h = Math.imul(h, 16777619) }
  return h >>> 0
}

// ─── 막혔을 때: 능력 쓰기 ────────────────────────────────────────────────

/**
 * 능력 쓰기 추천. proactive가 false면 '안 쓰면 다 못 놓는다', true면 '써 두면 더 낫다'.
 * gain은 쓴 쪽이 안 쓴 쪽보다 나은 정도(평가값, 대략 점수 단위).
 */
export type Rescue =
  | { kind: 'dot'; r: number; c: number; plan: Plan; proactive?: boolean; gain?: number }
  | { kind: 'swap'; slot: number; proactive?: boolean; gain?: number; room?: boolean }

/**
 * 세 조각을 다 놓을 수 없을 때 능력으로 살릴 길을 찾는다.
 *  - 점 찍기: 줄을 마저 채우는 칸, 가장 찬 줄의 빈칸부터 몇 군데 찍어 보고
 *    세 조각을 다 놓을 수 있게 되는 칸 중 가장 좋은 곳
 *  - 바꿔 뽑기: 점 찍기로 안 되면, 못 놓는 조각 중 가장 큰 것을 바꾼다
 * 점 찍기는 결과가 정해져 있고 바꿔 뽑기는 운이라서 점 찍기를 먼저 본다.
 */
export function rescue(inp: SolveInput, base: Plan | undefined): Rescue | null {
  if (!base?.incomplete) return null
  const swaps = inp.swaps ?? 0, dots = inp.dots ?? 0
  if (dots > 0) {
    const cells: { r: number; c: number; n: number }[] = []
    for (let r = 0; r < ROWS; r++) {
      const n = popcount(inp.board[r])
      for (let c = 0; c < COLS; c++) if (!((inp.board[r] >> c) & 1)) cells.push({ r, c, n })
    }
    cells.sort((a, b) => b.n - a.n)
    let best: Rescue | null = null
    for (const { r, c } of cells.slice(0, 14)) {
      const res = place(inp.board, DOT_SHAPE, r, c, inp.icons, inp.heldAbilities)
      const [plan] = searchPlans({ ...inp, board: res.board, icons: res.icons, beam: 60 }, 1)
      if (!plan || plan.incomplete) continue
      if (!best || (best.kind === 'dot' && plan.value > best.plan.value)) best = { kind: 'dot', r, c, plan }
    }
    if (best) return best
  }
  if (swaps > 0) {
    const placed = new Set(base.steps.map((s) => s.slot))
    let slot = -1, cells = -1
    inp.hand.forEach((h, i) => { if (h && !placed.has(i) && h.cells > cells) { slot = i; cells = h.cells } })
    if (slot >= 0) return { kind: 'swap', slot }
  }
  return null
}

/**
 * 막히기 전에 능력을 써 두는 게 나은지 본다.
 *  - 점 찍기: 한 칸만 빈 줄(특히 어떤 조각으로도 못 메우는 칸)을 찍어 지우면 판이 얼마나 나아지는지
 *  - 바꿔 뽑기: 이번 세트가 위험할 때, 카드마다 다른 조각으로 바뀐 경우를 몇 번 뽑아 평균이 얼마나 나아지는지
 * 능력은 합쳐 7개까지라 꽉 차 있으면 새로 못 얻는다. 한도가 가까우면 기준을 낮춰 아끼지 않고 쓴다.
 */
/**
 * 능력 쓰기 규칙. 가상 플레이 30판씩 비교로 골랐다 (2026-10-02, 평균 생존 세트 · 점수):
 *   막혔을 때만 쓰기                                   53.4 · 32,300
 *   꽉 찼고 아이콘을 놓칠 때만 털기 (collect)            53.2 · 32,300
 *   꽉 차면 이득이 될 때 바로, 바꿔 뽑기부터             57.4 · 35,600
 *   꽉 차면 이득이 될 때 바로, 점 찍기부터              58.5 · 36,500
 * 7개면 아이콘이 안 생기고 카운트도 멈추는 규칙을 넣고 다시 (30판씩):
 *   막혔을 때만 52.2 · 31,000 / 7개부터 58.5 · 35,800 / 6개부터 59.0 · 36,600 (지금 기준) / 5개부터 54.1 · 33,100
 *   꽉 차 있는 동안 능력 공급이 끊기니 6개쯤에서 털어 회전시키는 게 낫고, 5개부터는 위기용이 모자란다
 *
 *  - 바꿔 뽑기가 더 값지다. 어떤 조각이 막혀도 새로 뽑아 살릴 수 있지만 점 찍기는 한 칸만 메운다.
 *    그래서 바꿔 뽑기는 막혔을 때만 쓰고 아껴 둔다
 *  - 점 찍기는 막혔을 때, 또는 이득이 아주 클 때(대개 어떤 조각으로도 못 메우는 구멍이 있는 줄을 지울 때)
 *  - 6개 이상이면(7개면 아이콘이 안 생기고 카운트도 멈춘다) 이득이 되는 순간 점 찍기부터 털어 회전시킨다
 */
export const ADV = {
  /**
   * 마지막 평가에서 '다음 세트에 못 놓는 조각이 나올 확률'에 곱하는 벌점 (성향 무관한 몫).
   * 전에는 9,000 + (1 − 성향) × 26,000이라 성향 1.0이면 9,000뿐이었다. 3줄 더미 하나의 기대값이 이걸 넘어
   * "죽을 수도 있지만 쌓는다"가 돼 실제 판이 95세트에서 끝났다 (2026-10-03). 죽으면 뒤의 점수를 다 잃으니
   * 성향과 무관하게 크게 둔다: 앱 조건 8판, 성향 1.0에서 111.1세트·105,228 → 122.1·116,859
   */
  dangerBase: 25000,
  /** 위 벌점에 (1 − 성향)을 곱해 더하는 몫 */
  dangerStyle: 10000,
  /** 다음 세트 가상 플레이에서 죽는 표본 하나의 벌점 (능력을 들고 있을 때 / 없을 때). 위와 같은 이유로 올렸다 */
  deathHeld: 12000,
  deathNone: 24000,
  /**
   * 자식 후보를 추릴 때 부모 판의 잠재력 보너스를 어림값으로 얹는다 (searchPlans 참고).
   * 끄면 5줄 더미를 만들 수 있는 판(test/fixtures/stack5.png)에서 한 줄을 턴다. 다음 세트 가상 플레이 없이 돌리는
   * 가상 플레이(BUDGET=0)에서는 생존이 101 → 80세트로 나빠 보이지만, 앱 조건(BUDGET=200)에서는 성향 1.0에서 104.5 → 115.9세트
   */
  parentPot: true,
  /** 자식 후보를 추릴 때 부모마다 최소 몇 개는 넣는다 (0이면 안 함) */
  perParent: 0,
  /** 자식 후보를 추릴 때 한 부모에서 최대 몇 개까지 넣는다 (0이면 제한 없음) */
  parentCap: 0,
  /** 능력 하나의 가치: 900 − abilSlope × 보유 수, 바닥 abilFloor */
  abilFloor: 400,
  abilSlope: 100,
  /** 더미를 지울 조각을 기다리는 길이: 빈칸 ÷ drawsDiv 장, 최대 drawsMax 장 */
  drawsDiv: 6,
  drawsMax: 3,
  /** 점 찍기를 미리 쓰는 기준 이득. 1칸 모자란 줄을 2줄로 바꾸면 +900이라 그게 기준이다 (docs/SCORE-CYCLE.md 4절) */
  dotGain: 900, swapRisk: 2, swapGain: 300, cap: 6, keep: 0, capMode: 'any' as 'collect' | 'any',
  /** 6개면 바꿔 뽑기부터 턴다 (점 찍기가 더 값지다). 바꿔 뽑기는 손해만 없으면(nearCapSwapGain) 쓴다 */
  swapFirst: true,
  nearCapSwapGain: 0,
  /** 능력 하나를 얻는 가치 (iconWorth): 점 찍기 2개 미만 / 그 이상, 바꿔 뽑기 3개 미만 / 그 이상 */
  dotWorth: 900, dotWorthMany: 500, swapWorth: 300, swapWorthMany: 100,
  /** 더미 가치는 이 줄 수에서 자른다 (4줄 이상은 3줄과 같은 값) */
  stackMax: 3,
  /** 다음 세트 가상 플레이의 사망 표본 수를 1순위 정렬 기준으로 쓴다 */
  survivalFirst: true,
  /**
   * 최종 후보를 고를 때 못 덮는 빈칸(stuck) 하나당 깎는 값. 구멍이 세트마다 쌓이는 걸 막으려고 넣었지만 가상 플레이에서는
   * 나빴다 (앱 조건 8판·0.75: 0 → 137.0세트·134,483 / 300 → 131.9·124,493 / 600 → 111.9·104,004 / 900 → 135.1·130,572 / 600+구멍 300 → 115.6).
   * 막다른 칸·토막·엇갈림 벌점을 올려도 134세트 안팎으로 차이 없음. 구멍을 피하려 들수록 줄을 덜 지워 더 빨리 찬다. 꺼 둔다
   */
  stuckCost: 0,
  /**
   * 7개(꽉 참)일 때의 기회비용 (2026-10-03). 꽉 차 있으면 새 아이콘이 안 생기고 카운트도 멈춰 그 뒤 아이콘이 버려진다.
   * 실제 16만 점 판에서 215세트 동안 능력 88개를 얻었으니 세트당 0.41개, 능력 하나를 900으로 치면 세트당 약 370점이다.
   * 그래서 꽉 찼을 때는 '이득 > 0'이 아니라 '이득 > -capCost'면 쓴다. 쓰는 게 그보다 더 손해면 그냥 놓는다 (사용자 방침:
   * 무조건 쓰지는 않되 기회비용은 따진다). 점 찍기 후보도 한 칸 빈 줄만이 아니라 거의 찬 줄의 빈칸·못 메우는 구멍까지 본다
   */
  capCost: 0,
  /**
   * 6개(한도 가까움)일 때 능력을 미리 쓰려면 이만큼은 이득이어야 한다. 0이면 +340 같은 추정 오차 안의 차이로도
   * 쌓아 둔 3줄 더미를 점 찍기로 깨라고 했다 (실제 화면 로직.png). 더미 가치는 확률 추정이라 작은 차이는 믿지 않는다
   */
  nearCapGain: 500,
  /**
   * 계획 안의 점 찍기 (2026-10-03). 점 찍기를 keepDots개 넘게 들고 있으면 계획에 점 찍기 단계를 최대 planDotsMax개 넣는다.
   * 자리는 거의 찬 줄(채움 ≥ planDotRowMin)의 빈칸. 하나 쓸 때마다 planDotCost × 순번의 비용을 뺀다
   * (점 찍기가 많을수록 하나의 값어치는 낮다). 사용자: "점 찍기 5개 들고 있으면 두 칸 메워서 큰 제거 자리를 만들어야"
   * 처음에는 미리 찍으면 생존이 74세트로 줄었다. 빔 탐색 중간에도 잠재력을 붙이고 점 찍기 예산을 전체에서 한 번만 세게
   * 고친 뒤에는 켜는 쪽이 낫다: 켬 104.9세트 · 85,880 vs 끔 101.3 · 82,135 (potential 0.6, 8판).
   * 실제 화면(로직.png 셋째)에서 점 찍기 둘 + ㄱ3로 10열 5줄 더미를 만드는 계획이 나온다
   */
  planDots: true,
  /** 잠재력을 셀 때 남는 점 찍기로 모자란 칸을 메울 수 있다고 본다 (계획 단계 planDots와 따로 켠다) */
  dotFill: true,
  keepDots: 1,
  planDotsMax: 1,
  planDotCost: 700,
  planDotRowMin: 6,
  /** 꽉 찼을 때 점 찍기 후보를 거의 찬 줄의 빈칸·못 메우는 구멍까지 넓힌다 */
  capWide: false,
}

/** 계획대로 두면 꽉 차서 못 챙기는 아이콘들 */
function missedIcons(inp: SolveInput, plan: Plan): Icon['kind'][] {
  if (inp.heldAbilities < ABILITY_CAP) return []
  const out: Icon['kind'][] = []
  let icons = inp.icons
  for (const st of plan.steps) {
    for (const ic of icons) if (st.cleared.includes(ic.r)) out.push(ic.kind)
    icons = st.iconsAfter
  }
  return out
}

export function abilityAdvice(inp: SolveInput, base: Plan | undefined): Rescue | null {
  const stuck = rescue(inp, base)
  if (stuck || !base) return stuck
  const swaps = inp.swaps ?? 0, dots = inp.dots ?? 0
  // 후보마다 한 번씩 돌리므로 작은 빔으로 (꽉 찼을 때 점 찍기 후보 12칸 + 바꿔 뽑기 표본으로 1.4초가 걸렸다 → 약 0.5초)
  const quick = (i: SolveInput) => searchPlans({ ...i, beam: 30, budgetMs: 0 }, 1)[0]
  const now = quick(inp)
  if (!now || now.incomplete) return null

  const missed = ADV.capMode === 'collect' ? missedIcons(inp, base) : []
  const nearCap = ADV.capMode === 'any' ? inp.heldAbilities >= ADV.cap : false
  // 꽉 차서 못 챙기는 게 점 찍기면 바꿔 뽑기를 털어서라도 챙긴다. 바꿔 뽑기뿐이면 털어도 손해가 없을 때만
  const makeRoom = missed.length > 0 && swaps > 0
  const roomGain = missed.includes('dot') ? -Infinity : 0

  // 꽉 찼으면 점 찍기 후보를 넓히고(capWide), 기준을 기회비용만큼 내린다(capCost). 둘은 따로 켜고 끈다
  const atCap = inp.heldAbilities >= ABILITY_CAP
  const wide = atCap && ADV.capWide
  if (dots > 0) {
    const stuckMask = stuckRows(inp.board)
    // 점 찍기는 900(1줄을 2줄로) 이상 벌 때만. 6개 이상이고 바꿔 뽑기가 있으면 바꿔 뽑기부터 턴다 (swapFirst)
    let best: Rescue | null = null, bestGain = atCap ? -ADV.capCost : nearCap && !(ADV.swapFirst && swaps > 0) ? ADV.nearCapGain : ADV.dotGain
    // 후보 칸: 한 칸만 빈 줄의 그 칸. 꽉 찼으면 거의 찬 줄(빈칸 ≤ 4)의 빈칸과 어떤 조각으로도 못 메우는 칸까지 넓힌다
    const cells: [number, number][] = []
    for (let r = 0; r < ROWS; r++) {
      const row = inp.board[r], n = popcount(row)
      if (n === COLS - 1) cells.push([r, Math.log2(~row & FULL_ROW) | 0])
      else if (wide && n >= COLS - 4) for (let c = 0; c < COLS; c++) if (!((row >> c) & 1)) cells.push([r, c])
      else if (wide && stuckMask[r]) for (let c = 0; c < COLS; c++) if ((stuckMask[r] >> c) & 1) cells.push([r, c])
    }
    // 후보마다 탐색을 돌리므로 거의 찬 줄 순으로 12칸까지만 본다 (워커에서 1초 안에 끝나야 한다)
    cells.sort((a, b) => popcount(inp.board[b[0]]) - popcount(inp.board[a[0]]))
    for (const [r, c] of cells.slice(0, 12)) {
      const res = place(inp.board, DOT_SHAPE, r, c, inp.icons, inp.heldAbilities)
      const plan = quick({ ...inp, board: res.board, icons: res.icons, heldAbilities: inp.heldAbilities - 1 + res.abilities.length })
      if (!plan || plan.incomplete) continue
      // 어떤 조각으로도 못 메우는 칸이면 이 줄은 점 찍기 말고는 영영 못 지운다
      const bonus = (stuckMask[r] >> c) & 1 ? 600 : 0
      const gain = res.gained + plan.value - now.value + bonus
      if (gain > bestGain) { bestGain = gain; best = { kind: 'dot', r, c, plan, proactive: true, gain: Math.round(gain) } }
    }
    if (best) return best
  }

  if (swaps > 0 && (base.risk >= ADV.swapRisk || nearCap || makeRoom || atCap)) {
    const table = weightTable(inp.weights)
    const rand = rng(hashBoard(inp.board) ^ 0x51ed27)
    const SAMPLES = 5 // 3으로 줄이면 바꿔 뽑기 판단이 흔들려 생존이 124 → 90세트로 떨어졌다 (2026-10-03). 느려도 5개
    let best: Rescue | null = null
    // 꽉 찼는데 점 찍기를 쓸 만한 자리가 없으면 바꿔 뽑기도 기회비용만큼은 손해를 감수한다
    let bestGain = atCap ? -ADV.capCost : makeRoom ? roomGain : nearCap ? ADV.nearCapSwapGain : ADV.swapGain
    // 바꿀 카드는 바꾼 뒤 평균이 가장 좋은(손실이 가장 적은) 카드
    inp.hand.forEach((h, slot) => {
      if (!h) return
      let sum = 0
      for (let k = 0; k < SAMPLES; k++) {
        const repl = pick(table, rand)[0]
        const hand = inp.hand.slice()
        hand[slot] = repl
        const plan = quick({ ...inp, hand, heldAbilities: inp.heldAbilities - 1 })
        sum += !plan || plan.incomplete ? now.value - 20000 : plan.value
      }
      const gain = sum / SAMPLES - now.value
      if (gain > bestGain) { bestGain = gain; best = { kind: 'swap', slot, proactive: true, gain: Math.round(gain), room: makeRoom } }
    })
    if (best) return best
  }
  return null
}

/** 1칸 조각 말고는 어떤 조각으로도 덮을 수 없는 빈칸 (줄별 비트) */
function stuckRows(b: Board): Board {
  const covered = new Array(ROWS).fill(0)
  for (const p of PIECES) {
    if (p.shape.cells === 1) continue
    for (const s of PIECE_ORIENTS.get(p.id)!) {
      for (let r = 0; r + s.h <= ROWS; r++) for (let c = 0; c + s.w <= COLS; c++) {
        let ok = true
        for (let i = 0; i < s.h; i++) if (b[r + i] & (s.rows[i] << c)) { ok = false; break }
        if (ok) for (let i = 0; i < s.h; i++) covered[r + i] |= s.rows[i] << c
      }
    }
  }
  return b.map((row, r) => ~(row | covered[r]) & FULL_ROW)
}

/** 마우스로 조각을 집으면 커서는 조각의 가운데(위·왼쪽으로 내림) 칸을 잡는다 */
export function anchorCell(s: Shape, r: number, c: number): [number, number] {
  return [r + Math.floor((s.h - 1) / 2), c + Math.floor((s.w - 1) / 2)]
}
export const pocketsForTest = pockets

/** 테스트·진단용 */
export const quickEvalForTest = quickEval
export const finalEvalForTest = finalEval
