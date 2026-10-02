/// <reference lib="webworker" />
/**
 * 추천 계산은 정해 둔 시간(기본 1.5초)을 다 쓴다. 화면이 멈추지 않게 워커에서 돌리고,
 * 진행률을 틈틈이 보내서 '계산 중' 막대를 채운다.
 */
import { rescue, solve, type Plan, type Rescue, type SolveInput } from './core/solver'

export interface SolveRequest { id: number; input: SolveInput }
export type SolveResponse =
  | { id: number; type: 'progress'; progress: number }
  | { id: number; type: 'done'; plans: Plan[]; rescue: Rescue | null; ms: number }

self.onmessage = (e: MessageEvent<SolveRequest>) => {
  const { id, input } = e.data
  const t = performance.now()
  let last = 0
  const plans = solve(input, 5, {
    onProgress: (p) => {
      const now = performance.now()
      if (now - last < 60 && p < 1) return
      last = now
      self.postMessage({ id, type: 'progress', progress: p } satisfies SolveResponse)
    },
  })
  const help = rescue(input, plans[0])
  self.postMessage({ id, type: 'done', plans, rescue: help, ms: performance.now() - t } satisfies SolveResponse)
}
