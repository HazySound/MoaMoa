import { describe, expect, test } from 'vitest'
import { canPlace, emptyBoard, parseBoard, place, printBoard, orientations, FULL_ROW } from '../src/lib/core/board'
import { PIECES, defaultWeights, identify } from '../src/lib/core/pieces'
import { solve } from '../src/lib/core/solver'

const piece = (name: string) => PIECES.find((p) => p.name === name)!.shape

describe('규칙', () => {
  test('줄은 지워져도 위 블록이 내려오지 않는다', () => {
    const b = parseBoard(`
      ##########
      #########.`)
    const s = piece('점')
    expect(canPlace(b, s, 15, 9)).toBe(true)
    const r = place(b, s, 15, 9)
    expect(r.cleared).toEqual([15])
    expect(r.board[15]).toBe(0)
    expect(r.board[14]).toBe(FULL_ROW) // 그대로 남는다
    expect(r.gained).toBe(1 + 300)
  })
  test('여러 줄을 한 번에 지우면 300 × n²', () => {
    const b = parseBoard(`
      .#########
      .#########
      .#########
      .#########
      .#########`)
    const r = place(b, piece('ㅣ').h === 1 ? orientations(piece('ㅣ'))[1].shape : piece('ㅣ'), 11, 0)
    expect(r.cleared.length).toBe(5)
    expect(r.gained).toBe(5 + 7500)
  })
  test('능력 아이콘 줄을 지우면 능력과 50점', () => {
    const b = parseBoard('#########.')
    const r = place(b, piece('점'), 15, 9, [{ r: 15, c: 3, kind: 'swap' }])
    expect(r.abilities).toEqual(['swap'])
    expect(r.gained).toBe(1 + 300 + 50)
  })
  test('조각 19종은 모두 다른 모양', () => {
    expect(PIECES.length).toBe(19)
    for (const p of PIECES) expect(identify(orientations(p.shape).at(-1)!.shape)?.id).toBe(p.id)
  })
})

describe('추천', () => {
  test('빈 판에서 세 조각을 모두 놓는 계획을 낸다', () => {
    const t = performance.now()
    const plans = solve({ board: emptyBoard(), icons: [], hand: [piece('ㅌ'), piece('ㄹ'), piece('ㅏ')], heldAbilities: 0, weights: defaultWeights(1), style: 0.5 })
    const ms = performance.now() - t
    console.log('empty board solve ms', ms.toFixed(0))
    expect(plans.length).toBeGreaterThan(0)
    expect(plans[0].steps.length).toBe(3)
    expect(plans[0].incomplete).toBe(false)
  })
  test('한 칸 비어 있는 줄은 채워서 지운다', () => {
    const b = parseBoard(`
      ####.#####`)
    const plans = solve({ board: b, icons: [], hand: [piece('ㅣ'), null, null], heldAbilities: 0, weights: defaultWeights(1), style: 0.5 })
    expect(plans[0].gained).toBeGreaterThanOrEqual(300)
  })
  test('플레이 중간 판에서도 1초 안에 끝난다', () => {
    const b = parseBoard(`
      ....#.#...
      .....###..
      ....####..
      ......#...
      .....###..
      .....#####
      ..######.#
      .#########
      #####.....`)
    const t = performance.now()
    const plans = solve({ board: b, icons: [], hand: [piece('ㄷ'), piece('ㄹ'), piece('ㅊ')], heldAbilities: 0, weights: defaultWeights(1), style: 0.5 })
    const ms = performance.now() - t
    console.log('mid board solve ms', ms.toFixed(0), 'gained', plans[0].gained, 'risk', plans[0].risk.toFixed(3))
    console.log(printBoard(plans[0].board))
    expect(ms).toBeLessThan(3000)
    expect(plans[0].steps.length).toBe(3)
  })
})

import { pocketsForTest } from '../src/lib/core/solver'
test('고립된 빈칸 세기', () => {
  const b = parseBoard(`
    ##########
    #.########
    ##########
    ###..#####
    ##########
    #####.####
    #####.####
    ##########`)
  const [p1, p2] = pocketsForTest(b)
  expect(p1).toBe(1)
  expect(p2).toBe(4)
})

test('회전 버튼은 시계 방향 (플레이 영상에서 ㅗ 조각이 → ↓ ← ↑ 순서로 돈다)', async () => {
  const { parseShape, rotateCW } = await import('../src/lib/core/board')
  const right = parseShape('#.\n##\n#.')
  const down = rotateCW(right)
  expect(down.key).toBe(parseShape('###\n.#.').key)
  expect(rotateCW(down).key).toBe(parseShape('.#\n##\n.#').key)
})

describe('막혔을 때 능력', () => {
  // 모든 줄에 빈칸이 하나씩 엇갈려 있어 2칸 이상 조각은 어디에도 못 들어간다
  const rows = Array.from({ length: 16 }, (_, r) => Array.from({ length: 10 }, (_, c) => (c === (r % 2 ? 1 : 8) ? '.' : '#')).join(''))
  const b = parseBoard(rows.join('\n'))
  const base = () => solve({ board: b, icons: [], hand: [piece('ㅡ'), null, null], heldAbilities: 1, weights: defaultWeights(1), style: 0.2 })[0]

  test('점 찍기로 줄을 지워 자리를 만든다', async () => {
    const { rescue } = await import('../src/lib/core/solver')
    const plan = base()
    expect(plan.incomplete).toBe(true)
    const r = rescue({ board: b, icons: [], hand: [piece('ㅡ'), null, null], heldAbilities: 1, dots: 1, weights: defaultWeights(1), style: 0.2 }, plan)
    expect(r?.kind).toBe('dot')
    if (r?.kind === 'dot') expect(r.plan.incomplete).toBe(false)
  })
  test('점 찍기가 없으면 못 놓는 조각을 바꿔 뽑기', async () => {
    const { rescue } = await import('../src/lib/core/solver')
    const r = rescue({ board: b, icons: [], hand: [piece('ㅡ'), null, null], heldAbilities: 1, swaps: 1, weights: defaultWeights(1), style: 0.2 }, base())
    expect(r).toEqual({ kind: 'swap', slot: 0 })
  })
})

describe('조각 빈도', () => {
  test('표본이 쌓일수록 실제 빈도 쪽으로 옮겨 간다', async () => {
    const { blendedWeights, record } = await import('../src/lib/core/stats')
    const dot = PIECES.find((p) => p.name === '점')!.id
    const before = blendedWeights({}, 1).get(dot)!
    let c = {}
    for (let i = 0; i < 200; i++) c = record(c, 1, [dot])
    const after = blendedWeights(c, 1).get(dot)!
    expect(after).toBeGreaterThan(before * 3)
    expect([...blendedWeights(c, 1).values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
  })
})
