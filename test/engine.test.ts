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

describe('같은 조각 두 장', () => {
  test('추천과 다른 카드(같은 조각)로 같은 자리에 놓아도 다음 단계로 넘어간다', async () => {
    const { PIECES } = await import('../src/lib/core/pieces')
    const { emptyBoard } = await import('../src/lib/core/board')
    const g = PIECES.find((p) => p.name === 'ㄱ')!
    const t = PIECES.find((p) => p.name === 'ㅡ')!
    engine.reset()
    engine.board = emptyBoard()
    engine.hand = [g, g, t].map((p) => ({ state: 'piece', selected: false, shape: p.shape, piece: p }))
    engine.updatedAt = Date.now()
    engine.plans = solve({ board: engine.board, icons: [], hand: engine.hand.map((h: any) => h.shape), heldAbilities: 0, weights: new Map(PIECES.map((p) => [p.id, 1 / 19])), style: 0.2 }, 1)
    engine.planIdx = 0
    engine.stepIdx = 0
    engine.solving = false
    const st = engine.plan.steps.find((s: any) => s.slot < 2)
    // 첫 단계가 ㄱ이 되도록 계획 순서를 고정한다
    engine.plans = [{ ...engine.plan, steps: [st, ...engine.plan.steps.filter((s: any) => s !== st)] }]
    const other = st.slot === 0 ? 1 : 0
    engine.applyMove({ slot: other, shape: st.shape, r: st.r, c: st.c, cleared: st.cleared, board: st.boardAfter }, st.boardAfter)
    expect(engine.stepIdx).toBe(1)
    expect(engine.solving).toBe(false)
    expect(engine.plan.steps.slice(1).some((s: any) => s.slot === st.slot)).toBe(true) // 남은 ㄱ 단계는 아직 안 쓴 카드로
  })
})

describe('아이콘 반짝임', () => {
  test('블록 위 아이콘이 빈칸처럼 읽혔다 말았다 해도 점 찍기로 오해하거나 다시 맞추지 않는다', async () => {
    const { readCell } = await import('../src/lib/vision/read')
    const a = frame('icon-over2.png')
    // 같은 화면에서 (10,8) 칸 가장자리만 청록으로 칠해 '빈칸 위 아이콘'처럼 보이게 만든다
    const img = a.frame.image
    const b = { width: img.width, height: img.height, data: Uint8Array.from(img.data) }
    const g = a.grid, p = g.pitch, x0 = g.x + 8 * p, y0 = g.y + 10 * p
    for (let y = Math.floor(y0); y < y0 + p; y++) for (let x = Math.floor(x0); x < x0 + p; x++) {
      const fx = (x - x0) / p, fy = (y - y0) / p
      if (fx > 0.2 && fx < 0.8 && fy > 0.2 && fy < 0.8) continue
      const i = (y * img.width + x) * 4
      b.data[i] = 85; b.data[i + 1] = 185; b.data[i + 2] = 210
    }
    expect(readCell(img as any, g, 10, 8)).toBe('icon-dot-on')
    expect(readCell(b as any, g, 10, 8)).toBe('icon-dot')

    engine.reset()
    engine.dots = 1
    for (let i = 0; i < 2; i++) engine.ingest(a.frame, g, true)
    await flush()
    const board = engine.board.slice()
    const events = engine.events.length
    for (let i = 0; i < 30; i++) engine.ingest(i % 3 ? a.frame : { image: b, ox: 0, oy: 0 }, g, true)
    await flush()
    expect(engine.board).toEqual(board)
    expect(engine.dots).toBe(1)
    expect(engine.events.slice(0, engine.events.length - events).filter((e: any) => e.what === '계산')).toEqual([])
  })
})

describe('안 보이는 칸에 놓기', () => {
  const setup = async () => {
    const { PIECES } = await import('../src/lib/core/pieces')
    const { parseBoard, place } = await import('../src/lib/core/board')
    const dot = PIECES.find((p) => p.name === '점')!
    engine.reset()
    engine.board = parseBoard('.########.\n..........') // 아래에서 둘째 줄 9열이 아이콘 칸 (빈칸). 채워도 줄은 안 지워진다
    engine.hand = [
      { state: 'used', selected: false, shape: null, piece: null },
      { state: 'used', selected: false, shape: null, piece: null },
      { state: 'piece', selected: false, shape: dot.shape, piece: dot },
    ]
    engine.updatedAt = Date.now()
    const after = place(engine.board, dot.shape, 14, 9)
    engine.plans = [{ steps: [{ slot: 2, shape: dot.shape, flip: false, rot: 0, r: 14, c: 9, cleared: after.cleared, gained: 0, abilities: 0, boardAfter: after.board, iconsAfter: [] }], gained: 0, value: 0, risk: 0, stuck: 0, incomplete: false, board: after.board, abilityValue: 0, samples: 0 }]
    engine.planIdx = 0
    engine.stepIdx = 0
    engine.solving = false
    const unsure = new Array(16).fill(0); unsure[14] = 1 << 9
    engine.lastUnsure = unsure
    return { PIECES, after }
  }

  test('1칸 조각을 아이콘 칸에 넣으면 판은 그대로라도 카드가 사용 완료가 된 걸로 안다', async () => {
    const { after } = await setup()
    const used = { state: 'used', selected: false, shape: null }
    for (let i = 0; i < 2; i++) engine.watchCards([used, used, used], 2)
    expect(engine.board).toEqual(after.board)
    expect(engine.hand[2].state).toBe('used')
    expect(engine.stepIdx).toBe(1)
  })

  test('그 사이 새 세트가 떠도 바꿔 뽑기로 오해하지 않고, 남은 조각을 놓은 걸로 본 뒤 새 세트를 시작한다', async () => {
    const { PIECES, after } = await setup()
    engine.swaps = 2
    const card = (name: string) => ({ state: 'piece', selected: false, shape: PIECES.find((p) => p.name === name)!.shape })
    const next = [card('ㅇ'), card('ㄱ'), card('ㅊ')]
    for (let i = 0; i < 2; i++) engine.watchCards(next, 2)
    await flush()
    expect(engine.board).toEqual(after.board)
    expect(engine.swaps).toBe(2)
    expect(engine.hand.map((h: any) => h.piece?.name)).toEqual(['ㅇ', 'ㄱ', 'ㅊ'])
    expect(engine.hand.every((h: any) => h.state === 'piece')).toBe(true)
  })
})
