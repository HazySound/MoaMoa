/**
 * 가상 플레이. SIM=1 npx vitest run test/sim.test.ts
 * 조각을 고르게 뽑아 추천대로만 둘 때 몇 세트를 버티고 몇 점을 내는지 잰다.
 * 평가 가중치를 바꿀 때 나빠지지 않았는지 보는 용도다.
 */
import { test } from 'vitest'
import { emptyBoard, place, type Board } from '../src/lib/core/board'
import { PIECES, defaultWeights, stageOf } from '../src/lib/core/pieces'
import { solve } from '../src/lib/core/solver'

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
}

test.skipIf(!process.env.SIM)('self-play', () => {
  const games = +(process.env.GAMES ?? 6), maxSets = +(process.env.SETS ?? 120)
  const style = +(process.env.STYLE ?? 0.35)
  const results: string[] = []
  let totalSets = 0, totalScore = 0
  for (let gi = 0; gi < games; gi++) {
    const rand = rng(1000 + gi)
    let board: Board = emptyBoard(), score = 0, lines = 0, sets = 0
    for (; sets < maxSets; sets++) {
      const hand = [0, 1, 2].map(() => PIECES[Math.floor(rand() * PIECES.length)].shape)
      const [plan] = solve({ board, icons: [], hand, heldAbilities: 0, weights: defaultWeights(stageOf(lines)), style, beam: 60 })
      if (!plan || plan.incomplete) break
      for (const s of plan.steps) {
        const r = place(board, s.shape, s.r, s.c)
        board = r.board; score += r.gained; lines += r.cleared.length
      }
    }
    totalSets += sets; totalScore += score
    results.push(`game ${gi}: sets=${sets} score=${score} lines=${lines}`)
  }
  console.log(results.join('\n') + `\navg sets=${(totalSets / games).toFixed(1)} avg score=${Math.round(totalScore / games)}`)
}, 1_800_000)
