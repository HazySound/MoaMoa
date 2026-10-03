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

describe('꽉 찼을 때 능력 쓰기', () => {
  // 가상 플레이(2026-10-03): 꽉 찼다고 손해를 감수하며 쓰면(capCost 370·800) 생존이 124 → 82~86세트로 줄었고,
  // 점 찍기 후보를 넓히는 것(capWide)도 90 → 76세트로 나빠졌다. 그래서 꽉 차도 '이득일 때만' 쓴다 (capCost 0, capWide 꺼짐)
  const board = parseBoard(`
      ....######
      ...#######`)
  test('7개여도 안내가 있으면 이득이 양수인 자리뿐이다', async () => {
    const { abilityAdvice, solve, ADV } = await import('../src/lib/core/solver')
    expect(ADV.capCost).toBe(0)
    expect(ADV.capWide).toBe(false)
    const hand = [piece('ㅡ'), piece('ㄱ3'), piece('점')]
    const inp = { board, icons: [], hand, heldAbilities: 7, swaps: 3, dots: 4, weights: defaultWeights(1), style: 0.75, beam: 60 }
    const plan = solve(inp, 1)[0]
    const adv = abilityAdvice(inp, plan)
    if (adv) expect(adv.gain!).toBeGreaterThan(0)
  }, 30_000)
  test('기회비용 손잡이(capCost)를 켜면 그만큼 손해까지는 쓴다', async () => {
    const { abilityAdvice, solve, ADV } = await import('../src/lib/core/solver')
    const hand = [piece('ㅡ'), piece('ㄱ3'), piece('점')]
    const inp = { board, icons: [], hand, heldAbilities: 7, swaps: 3, dots: 4, weights: defaultWeights(1), style: 0.75, beam: 60 }
    const plan = solve(inp, 1)[0]
    const saved = { ...ADV }
    Object.assign(ADV, { capCost: 370, capWide: true })
    try {
      const adv = abilityAdvice(inp, plan)
      expect(adv).not.toBeNull()
      expect(adv!.gain!).toBeGreaterThan(-370)
    } finally { Object.assign(ADV, saved) }
  }, 30_000)
})

describe('큰 단위 제거 잠재력 (multiPotential)', () => {
  test('빈 판은 0, 두 줄이 같은 한 칸만 비었으면 2줄 제거 점수(1,200) × 그 자리를 메우는 조각 확률', async () => {
    const { multiPotential } = await import('../src/lib/core/solver')
    const w = defaultWeights(1)
    expect(multiPotential(emptyBoard(), w)).toBe(0)
    // 맨 아래 두 줄의 0열만 비었다: 세로로 세운 ㅡ(1×3)나 ㅣ(1×5)가 두 줄을 한 번에 메운다
    const b = parseBoard(`
      .#########
      .#########`)
    const v = multiPotential(b, w)
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThanOrEqual(1200)
  })
  test('한 열만 비운 다섯 줄은 ㅣ로 5줄(7,500)을 지울 수 있어 잠재력이 훨씬 크다', async () => {
    const { multiPotential } = await import('../src/lib/core/solver')
    const w = defaultWeights(1)
    const five = parseBoard(`
      .#########
      .#########
      .#########
      .#########
      .#########`)
    const two = parseBoard(`
      .#########
      .#########`)
    expect(multiPotential(five, w)).toBeGreaterThan(multiPotential(two, w) * 3)
  })
})

describe('쌓아 둔 줄을 깨지 않는다 (실제 화면 로직.png)', () => {
  // 1~3행이 모두 0열 한 칸만 비어 있다. ㅡ를 세로로 세우거나 ㅣ가 오면 3줄(2,700)이다.
  // 점 찍기로 가운데 줄을 털면 300점 받고 그 기회를 깬다 (전에는 그렇게 안내했다)
  const board = parseBoard(`
      ..........
      .#########
      .#########
      .#########
      ...#####.#
      ..........
      ..........
      ..........
      #.###..#..
      ###.......
      ..........
      ..........
      ...##.###.
      #####.....
      ...###....
      ..........`)
  const icons = [{ r: 0, c: 8, kind: 'dot' as const }, { r: 5, c: 1, kind: 'swap' as const }]
  test('점 찍기 안내가 쌓아 둔 줄(1~3행 0열)을 깨라고 하지 않는다', async () => {
    const { abilityAdvice, solve } = await import('../src/lib/core/solver')
    const { blendedWeights } = await import('../src/lib/core/stats')
    const { readFileSync } = await import('node:fs')
    const counts = JSON.parse(readFileSync('docs/data/piece-stats-2026-10-03.json', 'utf8')).counts
    const hand = [piece('ㄷ'), piece('ㄹ'), null]
    const inp = { board, icons, hand, heldAbilities: 6, swaps: 0, dots: 6, weights: blendedWeights(counts, 4), style: 0.75, beam: 60 }
    const plan = solve(inp, 1)[0]
    const adv = abilityAdvice(inp, plan)
    if (adv?.kind === 'dot') expect([adv.r, adv.c]).not.toEqual(expect.arrayContaining([1, 0]))
    if (adv?.kind === 'dot') expect(!(adv.c === 0 && adv.r >= 1 && adv.r <= 3), `점 찍기 ↓${adv.r + 1} →${adv.c + 1}`).toBe(true)
    // 추천 배치도 0열 1~3행을 메우지 않는다
    for (const st of plan.steps) for (let i = 0; i < st.shape.h; i++) {
      const r = st.r + i
      if (r >= 1 && r <= 3) expect((st.shape.rows[i] << st.c) & 1, `${r + 1}행 0열을 조각으로 메움`).toBe(0)
    }
  }, 30_000)
})

describe('더미를 하나 더 만들면 잠재력이 는다', () => {
  test('2줄 더미 둘은 하나보다 값이 크다 (더미별 합산 — 포화되면 더 쌓을 보람이 없다)', async () => {
    const { multiPotential } = await import('../src/lib/core/solver')
    const w = defaultWeights(1)
    const one = parseBoard(`
      .#########
      .#########`)
    const two = parseBoard(`
      .#########
      .#########
      ..........
      ..........
      #########.
      #########.`)
    expect(multiPotential(two, w)).toBeGreaterThan(multiPotential(one, w) * 1.6)
  })
})

describe('점 찍기를 넉넉히 들고 있으면 그걸로 메울 자리를 남기며 판을 짠다 (실제 화면 로직.png 둘째)', () => {
  // 손에 ㅡ 하나, 점 찍기 5개. 8행 "#####..#.." 9행 "#######..."에서 점 찍기로 칸을 메워 큰 제거 자리를 만들 수 있다.
  // 전에는 ㅡ를 9행 7~9열에 놓아 한 줄만 지우라고 했다
  const board = parseBoard(`
      ..........
      .#.#.#.##.
      ..........
      ..........
      ..........
      .#........
      ..........
      ##........
      #####..#..
      #######...
      ..........
      ......#...
      .....###..
      ..........
      ..........
      .#.#.##.#.`)
  const icons = [{ r: 5, c: 1, kind: 'swap' as const }, { r: 7, c: 9, kind: 'dot' as const }, { r: 15, c: 8, kind: 'swap' as const }]
  test('한 줄 제거 대신 큰 제거 자리를 만들고, 점 찍기를 쓰는 계획이 손해가 아니다', async () => {
    const { solve, ADV } = await import('../src/lib/core/solver')
    const { blendedWeights } = await import('../src/lib/core/stats')
    const { readFileSync } = await import('node:fs')
    const counts = JSON.parse(readFileSync('docs/data/piece-stats-2026-10-03.json', 'utf8')).counts
    const hand = [null, null, piece('ㅡ')]
    const inp = { board, icons, hand, heldAbilities: 5, swaps: 0, dots: 5, weights: blendedWeights(counts, 4), style: 0.75, beam: 60 }
    const { multiPotential } = await import('../src/lib/core/solver')
    const withDots = solve(inp, 1)[0]
    expect(withDots.steps.filter((s) => s.slot >= 0).length).toBe(1) // ㅡ는 꼭 놓는다
    // 한 줄만 지우고 끝내지 않는다 (전에는 ㅡ를 9행 7~9열에 놓아 1줄)
    const last = withDots.steps[withDots.steps.length - 1]
    expect(last.cleared.length === 1 && withDots.steps.length === 1).toBe(false)
    // 놓은 뒤의 판은 남는 점 찍기로 메워 큰 제거를 할 자리가 있다
    expect(multiPotential(withDots.board, inp.weights, 3)).toBeGreaterThan(0)
    const saved = ADV.planDots
    ADV.planDots = false
    try {
      const without = solve(inp, 1)[0]
      expect(withDots.value).toBeGreaterThanOrEqual(without.value)
    } finally { ADV.planDots = saved }
  }, 30_000)
})

describe('5줄 더미를 만들 수 있으면 한 줄을 털지 않는다 (실제 화면 로직.png 셋째)', () => {
  // 9~10행은 10열(0-based 9)만 비었고 11~13행은 몇 칸 더 비었다. 점 찍기 두 개와 ㄱ3(ㄴ자)로 메우면 10열이 5줄 연속으로 빈다.
  // 전에는 ㄱ3로 13행을 300점에 털어 더미를 깼다. 원인: 빔 탐색의 빠른 평가에 잠재력이 없어 쌓는 중간 단계가 잘려 나갔다
  test('추천이 한 줄을 지우지 않고 더미를 키우며, 점 찍기 단계가 들어간다', async () => {
    const { readFileSync } = await import('node:fs')
    const { PNG } = await import('pngjs')
    const { detectGrid, readBoard, readCards } = await import('../src/lib/vision/read')
    const { blendedWeights } = await import('../src/lib/core/stats')
    const { multiPotential } = await import('../src/lib/core/solver')
    const img = PNG.sync.read(readFileSync('test/fixtures/stack5.png')) as any
    const g = detectGrid(img)!
    const br = readBoard(img, g)
    const hand = readCards(img, g).map((c) => (c.state === 'piece' ? c.shape : null))
    const counts = JSON.parse(readFileSync('docs/data/piece-stats-2026-10-03.json', 'utf8')).counts
    const inp = { board: br.board, icons: br.icons, hand, heldAbilities: 5, swaps: 0, dots: 5, weights: blendedWeights(counts, 4), style: 0.75, beam: 160 }
    const plan = solve(inp, 1)[0]
    expect(plan.steps.some((s) => s.cleared.length === 1)).toBe(false)
    // 놓고 난 판은 10열(0-based 9)이 길게 비어, 남는 점 찍기로 메우면 ㅣ 하나로 4~5줄이 된다
    const dotsUsed = plan.steps.filter((s) => s.slot < 0).length
    expect(multiPotential(plan.board, inp.weights, Math.max(0, 3 - dotsUsed))).toBeGreaterThan(3000)
  }, 60_000)
})

describe('위기용 점 찍기도 이득이 확실하면 쓴다 (실제 화면 로직.png 넷째)', () => {
  // 5~12행이 10열만 비었고 5행은 2열도 비었다. 점 찍기 2개뿐이라 전에는 위기용으로 남겨 두느라 못 썼는데,
  // (5,2)에 하나 찍으면 ㅡ가 2줄에서 3줄이 돼 1,500점이 더 난다 (사용자 지적)
  test('점 찍기 (5,2) → ㅣ 5줄 → ㅡ 3줄 순서를 찾는다', async () => {
    const { readFileSync } = await import('node:fs')
    const { PNG } = await import('pngjs')
    const { detectGrid, readBoard, readCards } = await import('../src/lib/vision/read')
    const { blendedWeights } = await import('../src/lib/core/stats')
    const img = PNG.sync.read(readFileSync('test/fixtures/order35.png')) as any
    const g = detectGrid(img)!
    const br = readBoard(img, g)
    const hand = readCards(img, g).map((c) => (c.state === 'piece' ? c.shape : null))
    const counts = JSON.parse(readFileSync('docs/data/piece-stats-2026-10-03.json', 'utf8')).counts
    const inp = { board: br.board, icons: br.icons, hand, heldAbilities: 3, swaps: 1, dots: 2, weights: blendedWeights(counts, 4), style: 0.75, beam: 160 }
    const plan = solve(inp, 1)[0]
    const lines = plan.steps.map((s) => s.cleared.length).sort((a, b) => b - a)
    expect(lines.slice(0, 2)).toEqual([5, 3])
    expect(plan.steps.filter((s) => s.slot < 0).length).toBe(1)
    expect(plan.gained).toBeGreaterThan(10000)
  }, 60_000)
})
