/**
 * 가상 플레이 한 판. sim.test.ts(성능 재기)와 tune.test.ts(가중치 고르기)가 같이 쓴다.
 *
 * 게임 규칙을 최대한 따라 한다.
 *  - 세트마다 조각 3개 (등장 확률은 defaultWeights, 단계는 지운 줄 수로)
 *  - 조각을 7번 놓을 때마다 빈 칸 하나에 능력 아이콘 (바꿔 뽑기 60% · 점 찍기 40%), 판에 최대 3개
 *  - 아이콘 줄을 지우면 능력 획득 (최대 7개)
 *  - 다 못 놓게 되면 바꿔 뽑기 → 점 찍기 순서로 써서 버틴다
 *  - 점수 상한 500,000
 */
import { anyPlacement, emptyBoard, place, printBoard, type Board, type Icon, type Shape, ROWS, COLS } from '../src/lib/core/board'
import { PIECES, defaultWeights, stageOf } from '../src/lib/core/pieces'
import { blendedWeights } from '../src/lib/core/stats'
import { readFileSync } from 'node:fs'
import { abilityAdvice, rescue, solve, rng } from '../src/lib/core/solver'

/** 실험용: ADVICE=1이면 앱처럼 막히기 전에도 능력을 쓴다 */
const ADVICE = process.env.ADVICE === '1'
/** 실험용: REPLAN=1이면 조각 하나를 놓을 때마다 다시 계산한다. 앱은 인식 보정 때문에 세트 중간에 자주 다시 계산한다 (2026-10-04: 35세트에 28번) */
const REPLAN = process.env.REPLAN === '1'
/**
 * 실험용 조각 생성 규칙 (2026-10-04). 실제 게임이 판을 보고 조각을 고를 가능성을 재 본다.
 *  - (없음): 단계별 빈도에서 독립 추출
 *  - fit1: 세 조각 중 하나는 지금 판에 놓을 수 있게 다시 뽑는다 (사용자 관찰: 죽는 판도 최소 하나는 들어갔다)
 *  - fitall: 세 조각 모두 세트 시작 시점에 놓을 수 있게 하나씩 다시 뽑는다
 */
const GEN = process.env.GEN ?? ''

const DOT: Shape = { w: 1, h: 1, rows: [1], cells: 1, key: '1x1:1' }
export const CAP = 500_000

/** 실험용: SMALL=2면 5칸 이하 조각이 두 배 자주 나온다고 가정 */
const SMALL = +(process.env.SMALL ?? 1)
/**
 * REAL=1이면 실제 플레이에서 센 단계별 조각 빈도(docs/data, 두 PC 합산 870개)를 쓴다.
 * 1단계는 5칸 이하가 64%, 5단계는 36%라 균등 가정과 전혀 다르다
 */
const REAL = process.env.REAL === '1'
const realCounts = REAL ? JSON.parse(readFileSync('docs/data/piece-stats-2026-10-03.json', 'utf8')).counts : null
const stageWeights = new Map<number, Map<number, number>>()
export function weightsFor(lines: number): Map<number, number> {
  const stage = stageOf(lines)
  let w = stageWeights.get(stage)
  if (!w) {
    w = REAL ? blendedWeights(realCounts, stage) : new Map(defaultWeights(stage))
    if (!REAL && SMALL !== 1) {
      for (const p of PIECES) if (p.shape.cells <= 5) w.set(p.id, w.get(p.id)! * SMALL)
      const t = [...w.values()].reduce((a, b) => a + b, 0)
      for (const [k, v] of w) w.set(k, v / t)
    }
    stageWeights.set(stage, w)
  }
  return w
}
function drawPiece(rand: () => number, lines: number): Shape {
  const w = weightsFor(lines)
  let x = rand() * [...w.values()].reduce((a, b) => a + b, 0)
  for (const p of PIECES) { x -= w.get(p.id)!; if (x <= 0) return p.shape }
  return PIECES.at(-1)!.shape
}

export interface GameResult { sets: number; score: number; lines: number; usedAbil: number; combos: number[] }

export function playGame(gi: number, o: { maxSets: number; style: number; budget: number; beam: number; debug?: boolean }): GameResult {
  const { maxSets, style, budget, beam } = o
    const rand = rng(1000 + gi * 7919)
    let board: Board = emptyBoard(), icons: Icon[] = [], score = 0, lines = 0, sets = 0
    let placed = 0, swaps = 0, dots = 0, usedAbil = 0
    const combos = [0, 0, 0, 0, 0, 0]
    const give = (got: Icon['kind'][]) => { for (const k of got) { if (swaps + dots >= 7) break; if (k === 'swap') swaps++; else dots++ } }
    const spawn = () => {
      const empty: [number, number][] = []
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (!((board[r] >> c) & 1) && !icons.some((i) => i.r === r && i.c === c)) empty.push([r, c])
      if (!empty.length) return
      const [r, c] = empty[Math.floor(rand() * empty.length)]
      icons = [...icons, { r, c, kind: rand() < 0.6 ? 'swap' : 'dot' }].slice(-3)
    }
    outer: for (; sets < maxSets && score < CAP; sets++) {
      let hand: (Shape | null)[] = [0, 1, 2].map(() => drawPiece(rand, lines))
      if (GEN === 'fitall') hand = hand.map((h) => { for (let k = 0; k < 50 && !anyPlacement(board, h!); k++) h = drawPiece(rand, lines); return h })
      else if (GEN === 'fit1') for (let k = 0; k < 50 && !hand.some((h) => anyPlacement(board, h!)); k++) hand[k % 3] = drawPiece(rand, lines)
      while (hand.some(Boolean)) {
        const input = { board, icons, hand, heldAbilities: swaps + dots, swaps, dots, weights: weightsFor(lines), stage: stageOf(lines), style, beam, budgetMs: budget }
        const plan = solve(input)[0]
        // 앱과 똑같이 능력 추천을 따른다 (ADVICE면 막히기 전에도)
        if (plan?.incomplete || ADVICE) {
          const help = ADVICE ? abilityAdvice(input, plan) : rescue(input, plan)
          if (help?.kind === 'dot') {
            dots--; usedAbil++
            const r = place(board, DOT, help.r, help.c, icons, swaps + dots)
            board = r.board; icons = r.icons; score += r.gained; lines += r.cleared.length; give(r.abilities)
            continue
          }
          if (help?.kind === 'swap') { swaps--; usedAbil++; hand[help.slot] = drawPiece(rand, lines); continue }
        }
        if (plan && plan.steps.length) {
          // 다 못 놓는 계획이면 첫 단계만 두고 다시 본다
          const steps = plan.incomplete || REPLAN ? plan.steps.slice(0, 1) : plan.steps
          for (const st of steps) {
            const r = place(board, st.shape, st.r, st.c, icons, swaps + dots)
            board = r.board; icons = r.icons; score += r.gained; lines += r.cleared.length; give(r.abilities)
            combos[Math.min(5, r.cleared.length)]++
            // 계획 안의 점 찍기 단계
            if (st.slot < 0) { dots--; usedAbil++; continue }
            hand[st.slot] = null
            // 7개를 들고 있으면 아이콘이 생기지 않고 카운트도 멈춘다
            if (swaps + dots < 7 && ++placed % 7 === 0) spawn()
          }
          if (!plan.incomplete && !REPLAN) break
          continue
        }
        if (o.debug) {
          const shapeText = (h: Shape) => h.rows.map((row) => Array.from({ length: h.w }, (_, c) => ((row >> c) & 1 ? '#' : '.')).join('')).join('\n')
          console.log(`death set=${sets}\n${printBoard(board)}\nhand:\n${hand.filter(Boolean).map((h) => shapeText(h!)).join('\n--\n')}`)
        }
        break outer
      }
    }
  return { sets, score: Math.min(score, CAP), lines, usedAbil, combos }
}
