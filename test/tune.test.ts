/**
 * 빠른 평가 가중치(W)를 가상 플레이로 고른다. TUNE=1 npx vitest run test/tune.test.ts
 *
 * 몇 개를 조금씩 흔들어 같은 씨앗의 게임들을 다시 돌리고, 평균 생존 세트가 늘면 받아들인다.
 * 진행 상황은 TUNE_LOG 파일(기본 test/tune.log)에 한 줄씩 남긴다.
 * 환경 변수: ITERS GAMES SETS BEAM SEED
 */
import { appendFileSync } from 'node:fs'
import { test } from 'vitest'
import { W, rng } from '../src/lib/core/solver'
import { playGame } from './simlib'

test.skipIf(!process.env.TUNE)('tune', () => {
  const iters = +(process.env.ITERS ?? 60), games = +(process.env.GAMES ?? 6)
  const maxSets = +(process.env.SETS ?? 200), beam = +(process.env.BEAM ?? 60)
  const log = process.env.TUNE_LOG ?? 'test/tune.log'
  const rand = rng(+(process.env.SEED ?? 42))
  const keys = Object.keys(W) as (keyof typeof W)[]

  const evaluate = () => {
    let s = 0, sc = 0
    for (let g = 0; g < games; g++) {
      const r = playGame(g, { maxSets, style: 0.2, budget: 0, beam })
      s += r.sets; sc += r.score
    }
    return { sets: s / games, score: sc / games }
  }
  const write = (line: string) => appendFileSync(log, line + '\n')

  let best = { ...W }
  let bestR = evaluate()
  write(`start sets=${bestR.sets.toFixed(1)} score=${Math.round(bestR.score)} W=${JSON.stringify(best)}`)
  for (let it = 0; it < iters; it++) {
    const trial = { ...best }
    const n = 1 + Math.floor(rand() * 3)
    for (let k = 0; k < n; k++) {
      const key = keys[Math.floor(rand() * keys.length)]
      const g = Math.exp((rand() - 0.5) * 1.4)
      // 0인 항목은 켜 볼 수 있게 적당한 크기에서 시작한다
      trial[key] = trial[key] === 0 ? (key.startsWith('win') ? 40 : 20) * g : Math.round(trial[key] * g * 100) / 100
    }
    Object.assign(W, trial)
    const r = evaluate()
    const better = r.sets > bestR.sets
    write(`#${it} sets=${r.sets.toFixed(1)} score=${Math.round(r.score)} ${better ? 'ACCEPT' : 'reject'} ${JSON.stringify(trial)}`)
    if (better) { best = trial; bestR = r }
    else Object.assign(W, best)
  }
  write(`best sets=${bestR.sets.toFixed(1)} score=${Math.round(bestR.score)} W=${JSON.stringify(best)}`)
}, 24 * 3600_000)
