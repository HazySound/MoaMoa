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

describe('다음 능력까지', () => {
  test('조각을 놓을 때마다 하나씩 줄고 7번째에 다시 7, 점 찍기는 세지 않는다', async () => {
    const { PIECES } = await import('../src/lib/core/pieces')
    const { emptyBoard, place } = await import('../src/lib/core/board')
    const one = PIECES.find((p) => p.name === '점')!
    engine.reset()
    engine.board = emptyBoard()
    engine.hand = [0, 1, 2].map(() => ({ state: 'piece', selected: false, shape: one.shape, piece: one }))
    engine.plans = []
    engine.nextAbility = 7
    const seq: number[] = []
    for (let k = 0; k < 8; k++) {
      const slot = k % 3
      engine.hand = engine.hand.map((h: any, i: number) => (i === slot ? { ...h, state: 'piece' } : h))
      const res = place(engine.board, one.shape, 0, k)
      engine.applyMove({ slot, shape: one.shape, r: 0, c: k, cleared: res.cleared, board: res.board }, res.board)
      seq.push(engine.nextAbility)
    }
    expect(seq).toEqual([6, 5, 4, 3, 2, 1, 7, 6])
    const res = place(engine.board, one.shape, 1, 0)
    engine.dots = 1
    engine.applyMove({ slot: -1, shape: one.shape, r: 1, c: 0, cleared: [], board: res.board }, res.board)
    expect(engine.nextAbility).toBe(6)
  })
})

describe('능력 획득 (공지 규칙)', () => {
  const setup = async () => {
    const { PIECES } = await import('../src/lib/core/pieces')
    const { parseBoard, place } = await import('../src/lib/core/board')
    const dot = PIECES.find((p) => p.name === '점')!
    engine.reset()
    engine.board = parseBoard('#########.') // 맨 아래 줄 9열만 비었다
    engine.hand = [{ state: 'piece', selected: false, shape: dot.shape, piece: dot }, { state: 'used', selected: false, shape: null, piece: null }, { state: 'used', selected: false, shape: null, piece: null }]
    engine.plans = []
    engine.updatedAt = Date.now()
    engine.swaps = 0
    engine.dots = 0
    // 카운트를 알고 있고, 직전 배치가 7번째라 새 아이콘 차례다
    engine.nextAbility = 7
    engine.nextUnsure = false
    engine.spawnPending = true
    engine.events = []
    const res = place(engine.board, dot.shape, 15, 9)
    const mv = { slot: 0, shape: dot.shape, r: 15, c: 9, cleared: res.cleared, board: res.board }
    const cells = (iconAt: number | null) => Array.from({ length: 160 }, (_, i) => (i === iconAt ? 'icon-swap' : 'empty'))
    // 아이콘은 빈칸에 생기고, 그 뒤 그 칸에 블록이 놓인 상황을 만든다
    const spawnUnderBlock = () => {
      engine.board = parseBoard('###.#####.')
      for (let i = 0; i < 2; i++) engine.trackIcons(cells(15 * 10 + 3), engine.board, 2)
      engine.board = parseBoard('#########.')
    }
    return { mv, res, cells, spawnUnderBlock }
  }

  test('판이 바뀌기 전부터 있던 아이콘 줄을 지우면 획득', async () => {
    const { mv, spawnUnderBlock } = await setup()
    spawnUnderBlock()
    engine.applyMove(mv, mv.board)
    expect(engine.swaps).toBe(1)
    expect(engine.icons).toEqual([])
  })

  test('줄을 지운 직후 그 빈 줄에 새로 생긴 아이콘은 획득이 아니고 판에 남는다', async () => {
    const { mv, cells } = await setup()
    // 이번 배치가 7번째다. 아이콘은 판 변화를 확정하기 전부터 보이지만, 차례는 확정 뒤에 켜진다
    engine.nextAbility = 1
    engine.spawnPending = false
    for (let i = 0; i < 2; i++) engine.trackIcons(cells(15 * 10 + 3), mv.board, 2)
    engine.applyMove(mv, mv.board)
    for (let i = 0; i < 2; i++) engine.trackIcons(cells(15 * 10 + 3), mv.board, 2)
    expect(engine.swaps).toBe(0)
    expect(engine.icons).toEqual([{ r: 15, c: 3, kind: 'swap' }])
    // 확정 전 프레임은 조용히 넘긴다 ('무시' 기록 없음)
    expect(engine.events.some((e: any) => e.what === '아이콘 무시')).toBe(false)
  })

  test('7개를 들고 있으면 줄을 지워도 획득하지 않고 아이콘이 남는다', async () => {
    const { mv, spawnUnderBlock } = await setup()
    spawnUnderBlock()
    engine.swaps = 4
    engine.dots = 3
    engine.applyMove(mv, mv.board)
    expect(engine.swaps + engine.dots).toBe(7)
    expect(engine.icons.length).toBe(1)
  })

  test('조각을 놓은 직후가 아닌데 갑자기 보이는 아이콘(커서 오인)은 받지 않는다', async () => {
    const { cells } = await setup()
    engine.spawnPending = false
    engine.lastPlacedAt = Date.now() - 60_000
    for (let i = 0; i < 5; i++) engine.trackIcons(cells(5 * 10 + 4), engine.board, 2)
    expect(engine.icons).toEqual([])
  })
})

describe('커서를 아이콘으로 오인 (카운트를 알 때)', () => {
  const setup = async () => {
    const { emptyBoard } = await import('../src/lib/core/board')
    engine.reset()
    engine.board = emptyBoard()
    engine.updatedAt = Date.now()
    engine.nextUnsure = false
    engine.events = []
  }
  const cells = (...at: [number, string][]) => Array.from({ length: 160 }, (_, i) => at.find(([k]) => k === i)?.[1] ?? 'empty')

  test('아이콘 차례가 아닌 배치 직후에 보이는 아이콘은 받지 않는다', async () => {
    await setup()
    engine.nextAbility = 4 // 이번 배치는 7번째가 아니다
    engine.spawnPending = false
    engine.lastPlacedAt = Date.now() // 방금 놓았다
    for (let i = 0; i < 5; i++) engine.trackIcons(cells([42, 'icon-dot']), engine.board, 2)
    expect(engine.icons).toEqual([])
    expect(engine.events.filter((e: any) => e.what === '아이콘 무시').length).toBe(1)
  })

  test('차례여도 블록 위에서 보이는 것은 받지 않는다 (새 아이콘은 빈칸에만 생긴다)', async () => {
    await setup()
    engine.nextAbility = 7
    engine.spawnPending = true
    for (let i = 0; i < 3; i++) engine.trackIcons(cells([42, 'icon-dot-on']), engine.board, 2)
    expect(engine.icons).toEqual([])
    expect(engine.spawnPending).toBe(true) // 진짜 아이콘을 기다린다
  })

  test('차례에 두 칸이 같이 후보로 잡혀도 하나만 받는다', async () => {
    await setup()
    engine.nextAbility = 7
    engine.spawnPending = true
    engine.trackIcons(cells([42, 'icon-swap'], [77, 'icon-dot']), engine.board, 2)
    engine.trackIcons(cells([42, 'icon-swap'], [77, 'icon-dot']), engine.board, 2)
    for (let i = 0; i < 3; i++) engine.trackIcons(cells([42, 'icon-swap'], [77, 'icon-dot']), engine.board, 2)
    expect(engine.icons.length).toBe(1)
  })
})

describe('추천 자리를 찾느라 마우스를 판 위에 대고 있을 때 (기록 23:45:53~)', () => {
  const setup = async () => {
    const { PIECES } = await import('../src/lib/core/pieces')
    const { parseBoard } = await import('../src/lib/core/board')
    const by = (n: string) => PIECES.find((p) => p.name === n)!
    engine.reset()
    engine.board = parseBoard('###.......')
    engine.updatedAt = Date.now()
    engine.nextAbility = 5
    engine.nextUnsure = false
    engine.spawnPending = false
    engine.swaps = 2
    engine.dots = 3
    engine.plans = []
    engine.events = []
    engine.hand = [
      { state: 'used', selected: false, shape: null, piece: null },
      { state: 'piece', selected: true, shape: by('점').shape, piece: by('점') },
      { state: 'piece', selected: false, shape: by('ㅅ').shape, piece: by('ㅅ') },
    ]
    const cards = [
      { state: 'used', selected: false, shape: null },
      { state: 'piece', selected: true, shape: by('점').shape },
      { state: 'piece', selected: false, shape: by('ㅅ').shape },
    ]
    // 커서 때문에 빈칸 하나(↓8 →5)가 채워진 것처럼 읽힌다
    const B = parseBoard('###.......').slice()
    B[7] |= 1 << 4
    return { cards, B, before: engine.board.slice() }
  }
  const none = new Array(16).fill(0)

  test('한 칸 오독을 1칸 조각을 놓은 걸로 보지 않는다 (카드가 그대로 보이면 안 놓은 것)', async () => {
    const { cards, B, before } = await setup()
    for (let i = 0; i < 5; i++) engine.track(B, none, cards, true)
    expect(engine.board).toEqual(before)
    expect(engine.hand[1].state).toBe('piece')
    expect(engine.nextAbility).toBe(5)
    expect(engine.events.some((e: any) => e.what === '배치 무시')).toBe(true)
  })

  test('카드가 그대로면 1.5초로는 다시 맞추지 않고, 아주 오래 그대로여도 능력 카운트는 모름으로 만들지 않는다', async () => {
    const { cards, B, before } = await setup()
    for (let i = 0; i < 20; i++) engine.track(B, none, cards, true)
    expect(engine.board).toEqual(before) // 1.5초(10프레임)를 넘겨도 그대로
    for (let i = 0; i < 50; i++) engine.track(B, none, cards, true)
    await flush()
    expect(engine.board).toEqual(B) // 8초쯤 지나면 화면을 믿는다
    expect(engine.nextUnsure).toBe(false)
    expect(engine.abilityUnsure).toBe(false)
    expect(engine.nextAbility).toBe(5)
    expect(engine.spawnPending).toBe(false)
  })

  test('진짜로 놓았으면(카드가 사용 완료) 바로 따라간다', async () => {
    const { cards, B } = await setup()
    const usedNow = [cards[0], { state: 'used', selected: false, shape: null }, cards[2]]
    for (let i = 0; i < 2; i++) engine.track(B, none, usedNow, true)
    expect(engine.board).toEqual(B)
    expect(engine.hand[1].state).toBe('used')
    expect(engine.nextAbility).toBe(4)
  })
})

describe('능력 개수는 게임 화면 숫자가 기준', () => {
  const setup = async () => {
    const { PIECES } = await import('../src/lib/core/pieces')
    const { parseBoard } = await import('../src/lib/core/board')
    const by = (n: string) => PIECES.find((p) => p.name === n)!
    engine.reset()
    engine.screen.memory = { dots: [], swaps: [], next: [], held: [] } // 앞 테스트에서 배운 모양을 지운다
    engine.board = parseBoard('###.......')
    engine.updatedAt = Date.now()
    engine.nextAbility = 5
    engine.nextUnsure = false
    engine.swaps = 2
    engine.dots = 3
    engine.gameFull = false
    engine.plans = []
    engine.events = []
    engine.hand = ['ㄷ', 'ㅣ', 'ㅂ'].map((n) => ({ state: 'piece', selected: false, shape: by(n).shape, piece: by(n) }))
    const cards = engine.hand.map((h: any) => ({ state: 'piece', selected: false, shape: h.shape }))
    const B = parseBoard('###.......').slice()
    B[7] |= 1 << 4 // ↓8 →5 한 칸이 채워져 보인다
    return { cards, B, before: engine.board.slice() }
  }
  const none = new Array(16).fill(0)
  // 숫자마다 뚜렷이 다른 가짜 모양. guess는 획 구조 짐작이 낸 값이다
  const gl = (d: number | null) => {
    if (d === null) return null
    const f = new Array(36).fill(0)
    f[d] = 10
    return { f, guess: d, art: '' }
  }
  const nums = (dots: number | null, swaps: number | null, next: number | null, held: number | null, n = 3) => {
    for (let i = 0; i < n; i++) engine.syncNumbers({ dots: gl(dots), swaps: gl(swaps), next: gl(next), held: gl(held), why: {} }, false, true)
  }

  test('숫자가 그대로면 한 칸 오독을 점 찍기 사용으로 세지 않는다 (기록 0시 1분 26초)', async () => {
    const { cards, B, before } = await setup()
    nums(3, 2, 5, 5)
    for (let i = 0; i < 5; i++) engine.track(B, none, cards, true)
    expect(engine.board).toEqual(before)
    expect(engine.dots).toBe(3)
    expect(engine.events.some((e: any) => e.what === '점 찍기 사용')).toBe(false)
  })

  test('점 찍기 숫자가 실제로 줄면 그 한 칸을 점 찍기로 받는다', async () => {
    const { cards, B } = await setup()
    nums(3, 2, 5, 5)
    nums(2, 2, 5, 4, 1) // 이번 프레임: 숫자가 3 → 2
    for (let i = 0; i < 2; i++) engine.track(B, none, cards, true)
    expect(engine.board).toEqual(B)
    nums(2, 2, 5, 4)
    expect(engine.dots).toBe(2) // 두 번 빼지 않는다
  })

  test('도우미가 센 개수가 틀려도 화면 숫자로 바로잡는다', async () => {
    await setup()
    engine.abilityUnsure = true
    nums(3, 2, 4, 5)
    expect(engine.dots).toBe(3)
    expect(engine.swaps).toBe(2)
    nums(4, 2, 4, 6)
    expect(engine.dots).toBe(4)
    expect(engine.nextAbility).toBe(4)
    expect(engine.abilityUnsure).toBe(false)
  })

  test('버튼 숫자 하나가 엉뚱하게 읽혀도(1 + 2 ≠ 5) 그대로 믿지 않고 합으로 바로잡는다', async () => {
    await setup()
    nums(3, 2, 5, 5)
    nums(1, 2, 5, 5) // 점 찍기 자리가 1처럼 보인다. 바꿔 뽑기 2와 보유 5는 이미 확인된 모양이다
    expect(engine.dots).toBe(3)
    expect(engine.swaps).toBe(2)
  })

  test('버튼 숫자를 못 읽는 동안에도 따라 세기가 개수를 바꾸지 않는다 (보유 6개에서 혼자 줄던 원인)', async () => {
    const { cards, B, before } = await setup()
    nums(3, 2, 5, 5)
    nums(null, null, 5, null, 20) // 버튼 숫자가 한참 안 읽힌다 (전에는 2초 뒤 따라 세기로 돌아갔다)
    for (let i = 0; i < 5; i++) engine.track(B, none, cards, true)
    expect(engine.board).toEqual(before) // 한 칸 오독을 점 찍기 사용으로 받지 않는다
    expect([engine.dots, engine.swaps]).toEqual([3, 2])
  })

  test('실제 캡처(개수틀어짐.png): 도우미가 점 찍기를 2로 잘못 알고 있어도 화면의 3으로 바로잡는다', async () => {
    engine.reset()
    feed('count-off.png', 3)
    await flush()
    expect([engine.dots, engine.swaps, engine.nextAbility]).toEqual([3, 2, 2])
    engine.dots = 2 // 따라 세다가 틀어졌다고 치자 (사용자가 보낸 화면이 이 상태였다)
    engine.abilityUnsure = true
    feed('count-off.png', 1)
    expect(engine.dots).toBe(3)
    expect(engine.abilityUnsure).toBe(false)
  })

  test('실제 캡처(능력 꽉 참): 버튼 1 + 6을 읽는다', async () => {
    engine.reset()
    feed('full.png', 3)
    await flush()
    expect([engine.dots, engine.swaps]).toEqual([1, 6])
  })

  test('세트 중간에 능력을 얻어 6개 이상이 되면, 남은 조각으로 다시 계산해 능력을 쓸지 본다', async () => {
    await setup()
    nums(3, 2, 5, 5)
    await flush()
    engine.events = []
    nums(3, 3, 5, 6) // 줄을 지워 바꿔 뽑기를 얻었다 → 보유 6
    await flush()
    expect(engine.events.some((e: any) => (e.what === '계산' || e.what === '저장된 계산 사용') && e.detail === '능력이 늘어서')).toBe(true)
  })

  test('처음 화면 숫자에 맞출 때 값이 커지는 건 능력을 얻은 게 아니라서 다시 계산하지 않는다', async () => {
    await setup()
    engine.dots = 0
    engine.swaps = 0
    nums(4, 2, 5, 6)
    await flush()
    expect(engine.events.some((e: any) => e.detail === '능력이 늘어서')).toBe(false)
  })

  test('다음 능력이 1 → 7이 되면 새 아이콘 차례다', async () => {
    await setup()
    nums(3, 2, 1, 5)
    engine.spawnPending = false
    nums(3, 2, 7, 5)
    expect(engine.nextAbility).toBe(7)
    expect(engine.spawnPending).toBe(true)
  })
})

describe('원래 판에 있던 아이콘 (새로고침·화면 공유 다시 시작 뒤)', () => {
  test('카운트를 알아도, 다른 칸에 놓는 동안 그대로 있는 아이콘은 받는다 (실제 캡처: 템블록오류)', async () => {
    const { readBoard } = await import('../src/lib/vision/read')
    const { frame: fr, grid } = frame('icons-missing.png')
    const br = readBoard(fr.image, grid)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let t = 1_000_000
      vi.setSystemTime(t)
      engine.reset()
      engine.board = br.board
      engine.updatedAt = t
      engine.nextAbility = 4 // 사용자가 맞춰 둔 카운트 (게임과 같다)
      engine.nextUnsure = false
      engine.spawnPending = false
      engine.lastPlacedAt = 0
      engine.events = []
      // 놓기 전: 차례가 아니라 받지 않는다 (이때는 커서일 수도 있다)
      for (let i = 0; i < 10; i++) { vi.setSystemTime((t += 140)); engine.trackIcons(br.cells, engine.board, 2) }
      expect(engine.icons).toEqual([])
      // 다른 칸에 조각을 놓았다. 놓은 직후(1.5초 안)는 아직 받지 않는다
      engine.lastPlacedAt = (t += 140)
      for (let i = 0; i < 5; i++) { vi.setSystemTime((t += 140)); engine.trackIcons(br.cells, engine.board, 2) }
      expect(engine.icons).toEqual([])
      for (let i = 0; i < 10; i++) { vi.setSystemTime((t += 140)); engine.trackIcons(br.cells, engine.board, 2) }
      expect(engine.icons).toEqual([
        { r: 10, c: 0, kind: 'dot' },
        { r: 11, c: 5, kind: 'swap' },
        { r: 13, c: 7, kind: 'dot' },
      ])
      expect(engine.nextAbility).toBe(4) // 카운트는 그대로
    } finally {
      vi.useRealTimers()
    }
  })

  test('커서가 잠깐 머문 칸은, 놓은 뒤 그 칸을 떠났으면 받지 않는다', async () => {
    const { emptyBoard } = await import('../src/lib/core/board')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let t = 2_000_000
      vi.setSystemTime(t)
      engine.reset()
      engine.board = emptyBoard()
      engine.updatedAt = t
      engine.nextAbility = 4
      engine.nextUnsure = false
      engine.spawnPending = false
      const at = (k: number | null) => Array.from({ length: 160 }, (_, i) => (i === k ? 'icon-dot' : 'empty'))
      for (let i = 0; i < 5; i++) { vi.setSystemTime((t += 140)); engine.trackIcons(at(42), engine.board, 2) }
      // 커서가 떠나 5초 동안 안 보이다가 조각을 놓았다
      for (let i = 0; i < 36; i++) { vi.setSystemTime((t += 140)); engine.trackIcons(at(null), engine.board, 2) }
      engine.lastPlacedAt = (t += 140)
      vi.setSystemTime((t += 2000))
      engine.trackIcons(at(42), engine.board, 2)
      expect(engine.icons).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('아이콘 칸 기억이 틀렸을 때', () => {
  test('실제 캡처(템블록오류): 블록 위 아이템 칸을 빈칸으로 잘못 기억하고 있으면 블록으로 바로잡는다', async () => {
    engine.reset()
    feed('icon-on-block.png', 3)
    await flush()
    // ↓11 →3: 점 찍기 아이템이 블록 위에 있다. 처음 맞출 때는 화면에서 읽은 대로 블록이다
    expect((engine.board[10] >> 2) & 1).toBe(1)
    expect(engine.icons).toContainEqual({ r: 10, c: 2, kind: 'dot' })
    // 기억이 빈칸으로 틀어졌다 (사용자가 보낸 화면: 도우미가 그 칸에 조각을 놓으라고 추천했다)
    const wrong = engine.board.slice()
    wrong[10] &= ~(1 << 2)
    engine.board = wrong
    engine.events = []
    feed('icon-on-block.png', 12)
    await flush()
    expect((engine.board[10] >> 2) & 1).toBe(1)
    expect(engine.events.some((e: any) => e.what === '아이콘 칸 바로잡음' && e.detail.includes('빈칸 → 블록'))).toBe(true)
  })

  test('화면 기준으로 다시 맞출 때 아이템 칸은 기억이 아니라 화면에서 읽은 대로 둔다', async () => {
    engine.reset()
    feed('icon-on-block.png', 3)
    await flush()
    const wrong = engine.board.slice()
    wrong[10] &= ~(1 << 2)
    engine.board = wrong
    engine.resync(wrong, engine.hand.map((h: any) => ({ state: h.state === 'piece' ? 'piece' : 'used', selected: false, shape: h.shape })))
    expect((engine.board[10] >> 2) & 1).toBe(1)
  })

  test('빈칸 위 아이콘을 블록으로 기억하고 있으면, 밑이 계속 빈칸으로 읽힐 때 바로잡는다', async () => {
    const { parseBoard } = await import('../src/lib/core/board')
    engine.reset()
    engine.board = parseBoard('..........') // 맨 아래 줄 3열에 점 찍기 아이콘 (빈칸)
    engine.updatedAt = Date.now()
    engine.nextUnsure = true // 처음 맞출 때처럼 받는다
    engine.spawnPending = true
    engine.plans = []
    engine.hand = []
    engine.events = []
    const at = 15 * 10 + 2
    const cells = (s: string) => Array.from({ length: 160 }, (_, i) => (i === at ? s : 'empty'))
    for (let i = 0; i < 2; i++) engine.trackIcons(cells('icon-dot'), engine.board, 2)
    expect(engine.icons).toEqual([{ r: 15, c: 2, kind: 'dot' }])
    // 그런데 기억은 블록이라고 잘못 알고 있다 (스크린샷 제보: ↓16 →3)
    engine.board = parseBoard('..#.......')
    for (let i = 0; i < 30; i++) engine.trackIcons(cells(i % 4 ? 'icon-dot' : 'empty'), engine.board, 2)
    expect((engine.board[15] >> 2) & 1).toBe(0)
    expect(engine.events.some((e: any) => e.what === '아이콘 칸 바로잡음')).toBe(true)
    expect(engine.icons.length).toBe(1)
  })

  test('블록 위 아이콘이 가끔 빈칸 위처럼 읽혀도(반짝임) 블록 기억은 그대로 둔다', async () => {
    const { parseBoard } = await import('../src/lib/core/board')
    engine.reset()
    engine.board = parseBoard('..#.......')
    engine.updatedAt = Date.now()
    engine.nextUnsure = true
    engine.events = []
    const at = 15 * 10 + 2
    const cells = (s: string) => Array.from({ length: 160 }, (_, i) => (i === at ? s : 'empty'))
    for (let i = 0; i < 60; i++) engine.trackIcons(cells(i % 3 ? 'icon-dot-on' : 'icon-dot'), engine.board, 2)
    expect((engine.board[15] >> 2) & 1).toBe(1)
  })
})

describe('바꿔 뽑기 오인', () => {
  const setup = async () => {
    const { PIECES } = await import('../src/lib/core/pieces')
    const { emptyBoard } = await import('../src/lib/core/board')
    const by = (n: string) => PIECES.find((p) => p.name === n)!
    engine.reset()
    engine.board = emptyBoard()
    engine.updatedAt = Date.now()
    engine.nextAbility = 5
    engine.nextUnsure = false
    engine.swaps = 3
    engine.dots = 3
    engine.plans = []
    engine.hand = ['ㄷ', 'ㅣ', 'ㅂ'].map((n) => ({ state: 'piece', selected: false, shape: by(n).shape, piece: by(n) }))
    engine.events = []
    const card = (n: string) => ({ state: 'piece', selected: false, shape: by(n).shape })
    return { card }
  }
  const purple = { state: 'unknown', selected: false, shape: null }

  test('보라 카드(바꿔 뽑기 고르는 화면)를 못 봤으면 카드가 달리 읽혀도 개수를 줄이지 않는다', async () => {
    const { card } = await setup()
    for (let i = 0; i < 6; i++) engine.watchCards([card('ㄷ'), card('ㅎ'), card('ㅂ')], 2)
    await flush()
    expect(engine.swaps).toBe(3)
    expect(engine.events.some((e: any) => e.what === '카드 바뀜 무시')).toBe(true)
    // 2초 넘게 그대로면 카드만 고친다. 놓친 배치가 없으니 카운트를 '모름'으로 만들지 않는다
    for (let i = 0; i < 16; i++) engine.watchCards([card('ㄷ'), card('ㅎ'), card('ㅂ')], 2)
    await flush()
    expect(engine.hand.map((h: any) => h.piece?.name)).toEqual(['ㄷ', 'ㅎ', 'ㅂ'])
    expect(engine.swaps).toBe(3)
    expect(engine.nextUnsure).toBe(false)
    expect(engine.nextAbility).toBe(5)
  })

  test('보라 카드를 본 뒤 카드가 바뀌면 바꿔 뽑기 사용으로 센다', async () => {
    const { card } = await setup()
    for (let i = 0; i < 3; i++) engine.watchCards([purple, purple, purple], 2)
    for (let i = 0; i < 6; i++) engine.watchCards([card('ㄷ'), card('ㅎ'), card('ㅂ')], 2)
    await flush()
    expect(engine.swaps).toBe(2)
    expect(engine.hand[1].piece.name).toBe('ㅎ')
  })
})

describe('카드 기억이 꼬였을 때', () => {
  test('새 세트가 뜨자마자 하나를 놓아 버려도 2초 안에 화면 카드로 다시 맞춘다', async () => {
    const { PIECES } = await import('../src/lib/core/pieces')
    const { emptyBoard } = await import('../src/lib/core/board')
    const by = (n: string) => PIECES.find((p) => p.name === n)!
    engine.reset()
    engine.board = emptyBoard()
    engine.updatedAt = Date.now()
    // 기억: 이전 세트의 ㄷ만 남았다
    engine.hand = [
      { state: 'used', selected: false, shape: null, piece: null },
      { state: 'used', selected: false, shape: null, piece: null },
      { state: 'piece', selected: false, shape: by('ㄷ').shape, piece: by('ㄷ') },
    ]
    engine.lastUnsure = new Array(16).fill(0)
    // 화면: 새 세트 ㄱ3 · ㅎ · (하나는 이미 놓아서) 사용 완료
    const cards = [
      { state: 'piece', selected: false, shape: by('ㄱ3').shape },
      { state: 'piece', selected: false, shape: by('ㅎ').shape },
      { state: 'used', selected: false, shape: null },
    ]
    for (let i = 0; i < 20; i++) engine.watchCards(cards, 2)
    await flush()
    expect(engine.hand.map((h: any) => (h.state === 'used' ? '사용' : h.piece?.name))).toEqual(['ㄱ3', 'ㅎ', '사용'])
    expect(engine.events.some((e: any) => e.what === '카드와 기억이 달라 다시 맞춤')).toBe(true)
  })
})

describe('새 아이콘이 늦게 보일 때', () => {
  test('7번째 배치 뒤 아이콘 차례면, 미리보기 때문에 몇 초 늦게 보여도 받고 카운트를 맞춘다', async () => {
    const { emptyBoard } = await import('../src/lib/core/board')
    engine.reset()
    engine.board = emptyBoard()
    engine.updatedAt = Date.now()
    engine.lastPlacedAt = Date.now() - 10_000 // 10초 전에 놓았다 (그동안 미리보기가 떠 있었다)
    engine.spawnPending = true
    engine.nextAbility = 7
    const cells = Array.from({ length: 160 }, (_, i) => (i === 42 ? 'icon-dot' : 'empty'))
    for (let i = 0; i < 2; i++) engine.trackIcons(cells, engine.board, 2)
    expect(engine.icons).toEqual([{ r: 4, c: 2, kind: 'dot' }])
    expect(engine.spawnPending).toBe(false)
    // 다음 아이콘 차례가 아니면 다시 받지 않는다 (커서 오인 방지)
    const cells2 = Array.from({ length: 160 }, (_, i) => (i === 77 ? 'icon-dot' : 'empty'))
    for (let i = 0; i < 4; i++) engine.trackIcons(cells2, engine.board, 2)
    expect(engine.icons.length).toBe(1)
  })
})

describe('다음 능력 카운트가 초기화되던 문제', () => {
  const iconAt = (i: number) => Array.from({ length: 160 }, (_, k) => (k === i ? 'icon-dot' : 'empty'))

  test('카운트를 알고 있으면, 놓은 직후 새 아이콘(으로 보이는 것)이 나와도 7로 덮어쓰지 않는다', async () => {
    const { emptyBoard } = await import('../src/lib/core/board')
    engine.reset()
    engine.board = emptyBoard()
    engine.updatedAt = Date.now()
    engine.lastPlacedAt = Date.now() // 방금 놓았다
    engine.nextAbility = 4
    engine.nextUnsure = false
    for (let i = 0; i < 2; i++) engine.trackIcons(iconAt(42), engine.board, 2)
    expect(engine.nextAbility).toBe(4)
  })

  test('다시 맞춤 뒤 카운트를 모를 때(?)는 새 아이콘을 보고 7로 맞춘다', async () => {
    const { emptyBoard } = await import('../src/lib/core/board')
    engine.reset()
    engine.board = emptyBoard()
    engine.updatedAt = Date.now()
    engine.lastPlacedAt = Date.now()
    engine.nextAbility = 4
    engine.nextUnsure = true
    for (let i = 0; i < 2; i++) engine.trackIcons(iconAt(42), engine.board, 2)
    expect(engine.nextAbility).toBe(7)
    expect(engine.nextUnsure).toBe(false)
  })
})

describe('능력 획득 누락 (줄을 안 지운 배치에서 생긴 아이콘)', () => {
  test('7번째 배치로 생긴 아이콘은 그 뒤 다른 배치로 그 줄을 지우면 획득한다', async () => {
    const { PIECES } = await import('../src/lib/core/pieces')
    const { parseBoard, place } = await import('../src/lib/core/board')
    const dot = PIECES.find((p) => p.name === '점')!
    engine.reset()
    engine.board = parseBoard('########..')
    engine.updatedAt = Date.now()
    engine.swaps = 0
    engine.dots = 0
    engine.plans = []
    engine.hand = [0, 1, 2].map(() => ({ state: 'piece', selected: false, shape: dot.shape, piece: dot }))
    engine.nextAbility = 1 // 배치 1이 7번째다
    engine.nextUnsure = false
    engine.spawnPending = false
    // 배치 1: 8열에 놓는다 (줄은 안 지워짐). 이 배치 직후 같은 줄 9열(빈칸)에 아이콘이 생긴다
    const a = place(engine.board, dot.shape, 15, 8)
    const cells = (iconAt: number) => Array.from({ length: 160 }, (_, i) => (i === iconAt ? 'icon-swap' : 'empty'))
    for (let i = 0; i < 2; i++) engine.trackIcons(cells(15 * 10 + 9), a.board, 2) // 판이 바뀌는 중에 처음 보임
    engine.applyMove({ slot: 0, shape: dot.shape, r: 15, c: 8, cleared: a.cleared, board: a.board }, a.board)
    for (let i = 0; i < 2; i++) engine.trackIcons(cells(15 * 10 + 9), a.board, 2) // 확정 뒤 차례라 받는다
    expect(engine.icons).toEqual([{ r: 15, c: 9, kind: 'swap' }])
    // 배치 2: 아이콘 칸(9열)에 놓아 그 줄을 지운다 → 획득
    const b = place(engine.board, dot.shape, 15, 9)
    expect(b.cleared).toEqual([15])
    engine.applyMove({ slot: 1, shape: dot.shape, r: 15, c: 9, cleared: b.cleared, board: b.board }, b.board)
    expect(engine.swaps).toBe(1)
    expect(engine.icons).toEqual([])
  })
})
