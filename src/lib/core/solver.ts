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
  boardKey, lineScore, orientations, popcount,
} from './board'
import { PIECES, PIECE_ORIENTS } from './pieces'

export interface SolveInput {
  board: Board
  icons: Icon[]
  /** 카드 순서대로. 이미 놓은 카드는 null */
  hand: (Shape | null)[]
  heldAbilities: number
  /** 조각 id → 등장 확률 */
  weights: Map<number, number>
  /** 0 = 안전 위주, 1 = 점수 위주 */
  style: number
  /** 빔 너비. 기본 160 (시뮬레이션에서 줄여 쓴다) */
  beam?: number
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

function quickEval(b: Board, style: number): number {
  let v = 0
  for (let r = 0; r < ROWS; r++) {
    const row = b[r]
    if (!row) continue
    const n = popcount(row)
    // 꽉 찬 줄에 가까운 줄일수록 좋다 (곧 지울 수 있다). 점수 위주면 더 크게 본다
    v += (n * n) * (1.2 + style * 0.8)
    // 줄 안에서 빈칸이 여러 토막이면 한 조각으로 메우기 어렵다
    const empty = ~row & FULL_ROW
    const segs = popcount(empty & ~(empty << 1) & FULL_ROW)
    v -= (segs > 1 ? segs - 1 : 0) * 14
    // 위아래 줄과 엇갈린 칸 (세로로 들쭉날쭉한 판)
    if (r > 0) v -= popcount((row ^ b[r - 1]) & FULL_ROW) * 2.5
  }
  const filled = b.reduce((s, row) => s + popcount(row), 0)
  v -= filled * 6
  const [p1, p2, deadEnd] = pockets(b)
  v -= p1 * 70 + p2 * 50 + deadEnd * 6
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

export function solve(inp: SolveInput, topN = 5): Plan[] {
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

/** 마우스로 조각을 집으면 커서는 조각의 가운데(위·왼쪽으로 내림) 칸을 잡는다 */
export function anchorCell(s: Shape, r: number, c: number): [number, number] {
  return [r + Math.floor((s.h - 1) / 2), c + Math.floor((s.w - 1) / 2)]
}
export const pocketsForTest = pockets
