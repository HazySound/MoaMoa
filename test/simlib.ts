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
import { emptyBoard, place, printBoard, type Board, type Icon, type Shape, ROWS, COLS } from '../src/lib/core/board'
import { PIECES, defaultWeights, stageOf } from '../src/lib/core/pieces'
import { rescue, solve, rng } from '../src/lib/core/solver'

const DOT: Shape = { w: 1, h: 1, rows: [1], cells: 1, key: '1x1:1' }
export const CAP = 500_000

/** 실험용: SMALL=2면 5칸 이하 조각이 두 배 자주 나온다고 가정 */
const SMALL = +(process.env.SMALL ?? 1)
function drawPiece(rand: () => number, lines: number): Shape {
  const w = new Map(defaultWeights(stageOf(lines)))
  if (SMALL !== 1) for (const p of PIECES) if (p.shape.cells <= 5) w.set(p.id, w.get(p.id)! * SMALL)
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
      while (hand.some(Boolean)) {
        const input = { board, icons, hand, heldAbilities: swaps + dots, swaps, dots, weights: defaultWeights(stageOf(lines)), style, beam, budgetMs: budget }
        const plan = solve(input)[0]
        // 다 못 놓으면 앱과 똑같이 능력 추천(rescue)을 따른다
        if (plan?.incomplete) {
          const help = rescue(input, plan)
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
          const steps = plan.incomplete ? plan.steps.slice(0, 1) : plan.steps
          for (const st of steps) {
            const r = place(board, st.shape, st.r, st.c, icons, swaps + dots)
            board = r.board; icons = r.icons; score += r.gained; lines += r.cleared.length; give(r.abilities)
            combos[Math.min(5, r.cleared.length)]++
            hand[st.slot] = null
            if (++placed % 7 === 0) spawn()
          }
          if (!plan.incomplete) break
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
