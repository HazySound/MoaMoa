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
}

interface Cand { pi: number; slot: number; oi: number; r: number; c: number; quick: number }

const BEAM = 160
const FINAL = 48
/** 다음 세트 가상 플레이를 받는 후보 수 */
const ROLLOUT_CANDIDATES = 10
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
  /** 1칸짜리 구멍 */
  p1: 70,
  /** 2칸짜리 구멍 */
  p2: 50,
  /** 막다른 빈칸 */
  deadEnd: 6,
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
  const [p1, p2, deadEnd] = pockets(b)
  v -= p1 * W.p1 + p2 * W.p2 + deadEnd * W.deadEnd
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
  const danger = 9000 + (1 - inp.style) * 26000
  let value = st.gained + quickEval(st.board, inp.style) + o.flex * 600 - o.risk * danger - o.stuck * 120
  // 다 못 놓은 조각이 있으면 그 판은 끝난다
  value -= remaining * 100000
  return { value, o }
}

// ─── 탐색 ────────────────────────────────────────────────────────────────

function searchPlans(inp: SolveInput, topN: number): Plan[] {
  const slots = inp.hand.map((s, i) => [i, s] as const).filter((x): x is readonly [number, Shape] => x[1] !== null)
  const orients = new Map(slots.map(([i, s]) => [i, orientations(s)]))
  const start: State = { board: inp.board, icons: inp.icons, used: 0, gained: 0, held: inp.heldAbilities, steps: [], quick: 0 }

  let beam: State[] = [start]
  const finished: State[] = []
  for (let depth = 0; depth < slots.length; depth++) {
    // 자식 판은 수십만 개가 나온다. 먼저 가벼운 기록만 남기고, 빔에 들어간 것만 실제 상태로 만든다
    const best = new Map<string, Cand>()
    const scratch = new Array<number>(ROWS)
    beam.forEach((st, pi) => {
      let expanded = false
      const doneAbilities = st.steps.reduce((a, x) => a + x.abilities, 0)
      for (const [slot] of slots) {
        if (st.used & (1 << slot)) continue
        orients.get(slot)!.forEach((o, oi) => {
          const s = o.shape
          for (let r = 0; r + s.h <= ROWS; r++) for (let c = 0; c + s.w <= COLS; c++) {
            let ok = true
            for (let i = 0; i < s.h; i++) if (st.board[r + i] & (s.rows[i] << c)) { ok = false; break }
            if (!ok) continue
            expanded = true
            for (let k = 0; k < ROWS; k++) scratch[k] = st.board[k]
            let lines = 0, clearedMask = 0
            for (let i = 0; i < s.h; i++) {
              scratch[r + i] |= s.rows[i] << c
              if (scratch[r + i] === FULL_ROW) { lines++; clearedMask |= 1 << (r + i) }
            }
            let got = 0
            if (lines) {
              for (let k = 0; k < ROWS; k++) if (clearedMask & (1 << k)) scratch[k] = 0
              for (const ic of st.icons) if (clearedMask & (1 << ic.r) && st.held + got < ABILITY_CAP) got++
            }
            const gained = s.cells + lineScore(lines) + got * ABILITY_SCORE
            const quick = st.gained + gained + (doneAbilities + got) * 900 + quickEval(scratch, inp.style)
            const key = boardKey(scratch) + (st.used | (1 << slot))
            const prev = best.get(key)
            if (!prev || prev.quick < quick) best.set(key, { pi, slot, oi, r, c, quick })
          }
        })
      }
      if (!expanded) finished.push(st)
    })
    if (!best.size) break
    beam = [...best.values()].sort((a, b) => b.quick - a.quick).slice(0, inp.beam ?? BEAM).map((cd) => {
      const o = orients.get(cd.slot)![cd.oi]
      return expand(beam[cd.pi], cd.slot, o.flip, o.rot, o.shape, cd.r, cd.c, inp.style)
    })
  }
  const complete = beam.filter((s) => s.steps.length === slots.length)
  const pool = complete.length ? complete : [...beam, ...finished].sort((a, b) => b.steps.length - a.steps.length || b.quick - a.quick)

  const scored = pool.slice(0, FINAL).map((st) => {
    const { value, o } = finalEval(st, inp, slots.length - st.steps.length)
    return {
      steps: st.steps, gained: st.gained, value, risk: o.risk, stuck: o.stuck,
      incomplete: st.steps.length < slots.length, board: st.board,
      abilityValue: st.steps.reduce((a, x) => a + x.abilities, 0) * 900, samples: 0,
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

function expand(st: State, slot: number, flip: boolean, rot: number, s: Shape, r: number, c: number, style: number): State {
  const board = st.board.slice()
  const cleared: number[] = []
  for (let i = 0; i < s.h; i++) {
    board[r + i] |= s.rows[i] << c
    if (board[r + i] === FULL_ROW) cleared.push(r + i)
  }
  let gained = s.cells + lineScore(cleared.length)
  let icons = st.icons
  let got = 0
  if (cleared.length) {
    for (const row of cleared) board[row] = 0
    if (icons.length) {
      const left: Icon[] = []
      for (const ic of icons) {
        if (cleared.includes(ic.r) && st.held + got < ABILITY_CAP) { got++; gained += ABILITY_SCORE } else left.push(ic)
      }
      icons = left
    }
  }
  const step: Step = { slot, shape: s, flip, rot, r, c, cleared, gained, abilities: got, boardAfter: board, iconsAfter: icons }
  const total = st.gained + gained
  // 능력 하나는 점수 50점보다 훨씬 값지다(다음 위기에서 판을 살린다)
  const abilityBonus = got * 900
  const acc = st.steps.reduce((a, x) => a + x.abilities, 0) * 900
  return {
    board, icons, used: st.used | (1 << slot), gained: total, held: st.held + got,
    steps: [...st.steps, step],
    quick: total + acc + abilityBonus + quickEval(board, style),
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
      const r = rollout(p.board, set, inp.style)
      if (r === null) deaths[i]++
      else sums[i] += r
    })
    samples++
    opts.onProgress?.(Math.min(0.99, 0.35 + 0.65 * (now() - t0) / budget))
  }
  // 죽는 표본은 크게 깎는다. 능력이 있으면 한 번은 버틸 수 있어서 덜 깎는다
  const deathCost = (inp.heldAbilities > 0 ? 9000 : 20000) * (1.2 - inp.style * 0.4)
  const scored = cands.map((p, i) => {
    const alive = samples - deaths[i]
    const mean = (sums[i] - deaths[i] * deathCost) / samples
    return { p, v: p.gained + p.abilityValue + mean, risk: deaths[i] / samples, alive }
  })
  scored.sort((a, b) => b.v - a.v)
  opts.onProgress?.(1)
  return scored.slice(0, topN).map(({ p, v, risk }) => ({ ...p, value: v, risk, samples }))
}

/** 판 위에서 세 조각을 작은 빔으로 놓아 본다. 다 못 놓으면 null */
function rollout(board: Board, set: Shape[][], style: number): number | null {
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
  return beam[0].q
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

export type Rescue =
  | { kind: 'dot'; r: number; c: number; plan: Plan }
  | { kind: 'swap'; slot: number }

const DOT_SHAPE: Shape = { w: 1, h: 1, rows: [1], cells: 1, key: '1x1:1' }

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

/** 마우스로 조각을 집으면 커서는 조각의 가운데(위·왼쪽으로 내림) 칸을 잡는다 */
export function anchorCell(s: Shape, r: number, c: number): [number, number] {
  return [r + Math.floor((s.h - 1) / 2), c + Math.floor((s.w - 1) / 2)]
}
export const pocketsForTest = pockets
