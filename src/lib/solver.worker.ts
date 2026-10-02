/// <reference lib="webworker" />
/**
 * 추천 계산은 0.3~0.5초쯤 걸린다. 화면이 멈추지 않게 워커에서 돌린다.
 */
import { solve, type Plan, type SolveInput } from './core/solver'

export interface SolveRequest { id: number; input: SolveInput }
export interface SolveResponse { id: number; plans: Plan[]; ms: number }

self.onmessage = (e: MessageEvent<SolveRequest>) => {
  const t = performance.now()
  const plans = solve(e.data.input, 5)
  const res: SolveResponse = { id: e.data.id, plans, ms: performance.now() - t }
  self.postMessage(res)
}
