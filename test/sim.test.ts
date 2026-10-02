/**
 * 가상 플레이로 추천 성능을 잰다. SIM=1 npx vitest run test/sim.test.ts
 * 환경 변수: GAMES(판 수) SETS(판당 최대 세트) BUDGET(세트당 계산 ms) STYLE BEAM DEBUG
 */
import { test } from 'vitest'
import { playGame } from './simlib'
import { ADV, W } from '../src/lib/core/solver'

test.skipIf(!process.env.SIM)('self-play', () => {
  // 가중치를 바꿔 보는 실험: W_JSON='{"p1":200}'
  if (process.env.W_JSON) Object.assign(W, JSON.parse(process.env.W_JSON))
  if (process.env.ADV_JSON) Object.assign(ADV, JSON.parse(process.env.ADV_JSON))
  const games = +(process.env.GAMES ?? 4), maxSets = +(process.env.SETS ?? 150)
  const style = +(process.env.STYLE ?? 0.2), budget = +(process.env.BUDGET ?? 0), beam = +(process.env.BEAM ?? 160)
  const out: string[] = []
  let tSets = 0, tScore = 0, tAbil = 0
  const combos = [0, 0, 0, 0, 0, 0]
  const t0 = performance.now()
  for (let gi = 0; gi < games; gi++) {
    const r = playGame(gi + +(process.env.OFFSET ?? 0), { maxSets, style, budget, beam, debug: !!process.env.DEBUG })
    tSets += r.sets; tScore += r.score; tAbil += r.usedAbil
    r.combos.forEach((n, i) => (combos[i] += n))
    out.push(`game ${gi}: sets=${r.sets} score=${r.score} lines=${r.lines} abilitiesUsed=${r.usedAbil}`)
  }
  const secs = (performance.now() - t0) / 1000
  console.log(out.join('\n') + `\nAVG sets=${(tSets / games).toFixed(1)} score=${Math.round(tScore / games)} abil=${(tAbil / games).toFixed(1)} clears(1..5)=${combos.slice(1).join('/')} (${secs.toFixed(0)}s)`)
}, 7_200_000)
