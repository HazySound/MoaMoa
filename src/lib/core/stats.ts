/**
 * 실제로 나온 조각 세기.
 *
 * 공식 등장 확률은 비공개라 처음에는 defaultWeights(고른 확률 + 단계 보정)로 어림한다.
 * 플레이하면서 새 세트마다 조각을 단계별로 세고, 표본이 쌓일수록 그 빈도 쪽으로 옮겨 간다.
 * 이 브라우저에만 남는다 (localStorage).
 */
import { PIECES, defaultWeights } from './pieces'

const KEY = 'moamoa.stats.v1'

/** 단계(1~5) → 조각 id → 나온 횟수 */
export type Counts = Record<number, Record<number, number>>

export function loadCounts(): Counts {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} }
}

export function saveCounts(c: Counts) {
  try { localStorage.setItem(KEY, JSON.stringify(c)) } catch { /* 저장 못 해도 계산은 된다 */ }
}

export function record(c: Counts, stage: number, ids: number[]): Counts {
  const next = { ...c, [stage]: { ...(c[stage] ?? {}) } }
  for (const id of ids) next[stage][id] = (next[stage][id] ?? 0) + 1
  return next
}

export function seenIn(c: Counts, stage: number): number {
  return Object.values(c[stage] ?? {}).reduce((a, b) => a + b, 0)
}

/**
 * 어림값과 실제 빈도를 섞는다. 기본값을 조각당 PRIOR번 본 것처럼 두고 실제 횟수를 더하는
 * 방식이라, 표본이 적을 때는 어림값에 가깝고 많아지면 실제 빈도에 가까워진다.
 */
const PRIOR = 4
export function blendedWeights(c: Counts, stage: number): Map<number, number> {
  const base = defaultWeights(stage)
  const seen = c[stage] ?? {}
  const w = new Map<number, number>()
  let total = 0
  for (const p of PIECES) {
    const v = (base.get(p.id) ?? 0) * PRIOR * PIECES.length + (seen[p.id] ?? 0)
    w.set(p.id, v)
    total += v
  }
  for (const [k, v] of w) w.set(k, v / total)
  return w
}

// ─── 판 기록 ─────────────────────────────────────────────────────────────

/**
 * 한 판의 기록. 점수는 화면의 점수 숫자를 읽는 게 아니라 판 변화로 센 값이다
 * (조각 칸 수 + 줄 제거 300×n² + 능력 50). 중간부터 공유했으면 fromStart가 false라 앞부분이 빠져 있다.
 */
export interface GameLog {
  start: number
  end: number
  fromStart: boolean
  score: number
  lines: number
  sets: number
  pieces: number
  swapsUsed: number
  dotsUsed: number
  /** 한 번에 지운 줄 수별 횟수 [0, 1줄, 2줄, 3줄, 4줄, 5줄] */
  clears: number[]
}

const GAMES_KEY = 'moamoa.games.v1'

export const newGame = (fromStart: boolean): GameLog => ({
  start: Date.now(), end: Date.now(), fromStart, score: 0, lines: 0, sets: 0, pieces: 0, swapsUsed: 0, dotsUsed: 0, clears: [0, 0, 0, 0, 0, 0],
})

export interface GameHistory { current: GameLog | null; past: GameLog[] }

export function loadGames(): GameHistory {
  try { return { current: null, past: [], ...JSON.parse(localStorage.getItem(GAMES_KEY) ?? '{}') } } catch { return { current: null, past: [] } }
}

export function saveGames(h: GameHistory) {
  try { localStorage.setItem(GAMES_KEY, JSON.stringify(h)) } catch { /* 이번 창에서만 남는다 */ }
}
