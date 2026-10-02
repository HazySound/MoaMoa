/**
 * 엔진을 실제 캡처 순서대로 돌려 본다. 화면 공유 대신 ingest에 프레임을 직접 넣는다.
 */
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { detectGrid } from '../src/lib/vision/read'
import { solve } from '../src/lib/core/solver'

// 워커 대신 같은 스레드에서 바로 계산한다
vi.mock('../src/lib/solver.worker?worker', () => ({
  default: class {
    onmessage: ((e: { data: unknown }) => void) | null = null
    terminate() {}
    postMessage(req: { id: number; input: Parameters<typeof solve>[0] }) {
      const plans = solve(req.input, 5)
      queueMicrotask(() => this.onmessage?.({ data: { id: req.id, type: 'done', plans, rescue: null, ms: 0 } }))
    }
  },
}))

type AnyEngine = any
let engine: AnyEngine

beforeAll(async () => {
  ;(globalThis as any).window = globalThis
  engine = (await import('../src/lib/engine.svelte')).engine
})

const frame = (f: string) => {
  const image = PNG.sync.read(readFileSync(`test/fixtures/${f}`)) as any
  return { frame: { image, ox: 0, oy: 0 }, grid: detectGrid(image)! }
}
const feed = (f: string, n = 2) => { const { frame: fr, grid } = frame(f); for (let i = 0; i < n; i++) engine.ingest(fr, grid, true) }
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('엔진 추적', () => {
  test('처음 두 프레임으로 판과 세트를 잡고 한 번 계산한다', async () => {
    feed('play1.png')
    await flush()
    expect(engine.updatedAt).toBeGreaterThan(0)
    expect(engine.hand.map((h: any) => h.piece?.name)).toEqual(['ㄷ', 'ㄹ', 'ㅊ'])
    expect(engine.plan?.steps.length).toBe(3)
  })

  test('배치 미리보기 프레임은 무시한다', async () => {
    const before = engine.plan
    feed('hover1.png', 5) // 다른 판의 미리보기 화면이지만 busy라서 아무 일도 없어야 한다
    await flush()
    expect(engine.plan).toBe(before)
    expect(engine.hand.map((h: any) => h.state)).toEqual(['piece', 'piece', 'piece'])
  })

  test('ㅊ을 놓은 판이 들어오면 3번 카드를 사용으로 표시한다', async () => {
    feed('play2.png')
    await flush()
    expect(engine.hand.map((h: any) => h.state)).toEqual(['piece', 'piece', 'used'])
    // 추천과 다르게 놓았다면 남은 두 조각으로 다시 계산했어야 한다
    expect(engine.plan.steps.every((s: any) => s.slot !== 2)).toBe(true)
  })

  test('설명되지 않는 판은 잠깐은 무시하고, 오래 그대로면 화면에 맞춘다', async () => {
    const b = engine.board.slice()
    feed('stuck-dot.png', 3)
    expect(engine.board).toEqual(b)
    feed('stuck-dot.png', 10)
    await flush()
    expect(engine.board).not.toEqual(b)
    expect(engine.hand.map((h: any) => h.piece?.name)).toEqual(['ㄷ', 'ㅣ', 'ㅂ'])
    expect(engine.icons.length).toBe(3)
  })
})

describe('추천대로 놓기', () => {
  test('계획 그대로면 다시 계산하지 않고 단계만 넘어간다', async () => {
    const { explainMove } = await import('../src/lib/core/track')
    engine.reset()
    feed('empty3.png')
    await flush()
    const plan = engine.plan
    expect(plan.steps.length).toBe(3)
    for (let k = 0; k < 3; k++) {
      const st = plan.steps[k]
      const hand = engine.hand.flatMap((h: any, slot: number) => (h.state === 'piece' ? [{ slot, shape: h.shape }] : []))
      const mv = explainMove(engine.board, st.boardAfter, hand, true)
      expect(mv?.slot).toBe(st.slot)
      engine.applyMove(mv, st.boardAfter)
      expect(engine.plan).toBe(plan) // 같은 계획 그대로
      expect(engine.stepIdx).toBe(k + 1)
      expect(engine.solving).toBe(false)
    }
    expect(engine.hand.every((h: any) => h.state === 'used')).toBe(true)
  })
})
