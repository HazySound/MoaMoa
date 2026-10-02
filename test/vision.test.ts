import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { describe, expect, test } from 'vitest'
import { detectGrid, readBoard, readCards, type Grid } from '../src/lib/vision/read'
import { parseBoard, printBoard } from '../src/lib/core/board'
import { identify } from '../src/lib/core/pieces'
import { whiten } from './helpers'

const load = (f: string) => PNG.sync.read(readFileSync(`test/fixtures/${f}`))

function read(f: string) {
  const img = load(f)
  const g = detectGrid(img) as Grid
  expect(g).not.toBeNull()
  return { g, board: readBoard(img, g), cards: readCards(img, g) }
}

const names = (cards: ReturnType<typeof readCards>) =>
  cards.map((c) => (c.state === 'used' ? '사용' : c.shape ? identify(c.shape)?.name ?? '?' : '-'))

describe('판 위치', () => {
  test.each([
    ['play1.png', 13, 152], ['play2.png', 10, 151], ['play3.png', 8, 145],
    ['hover1.png', 17, 137], ['clearpreview.png', 15, 144], ['empty3.png', 39, 174],
  ])('%s', (f, x, y) => {
    const { g } = read(f)
    expect(g.x).toBeCloseTo(x, -0.5)
    expect(g.y).toBeCloseTo(y, -0.5)
    expect(g.pitch).toBeCloseTo(36.6, 0)
  })
})

describe('판 읽기', () => {
  test('플레이1', () => {
    const { board } = read('play1.png')
    expect(printBoard(board.board)).toBe(printBoard(parseBoard(`
      ....#.#...
      .....###..
      ....####..
      ......#...
      .....###..
      .....#####
      ..######.#
      .#########
      #####.....`)))
    expect(board.busy).toBe(false)
    expect(board.icons).toEqual([])
  })
  test('플레이2: 바꿔 뽑기 아이콘과 커서', () => {
    const { board } = read('play2.png')
    expect(board.icons).toEqual([{ r: 12, c: 3, kind: 'swap' }])
    expect(board.cursor).toEqual([5])
  })
  test('플레이3: 지워진 줄은 비고 위 블록은 그대로', () => {
    const { board } = read('play3.png')
    expect(board.board[12]).toBe(0)
    expect(printBoard(board.board).split('\n')[11]).toBe('.....###..')
  })
  test.each(['hover1.png', 'hover2.png', 'clearpreview.png'])('%s: 배치 미리보기 중에는 읽지 않는다', (f) => {
    expect(read(f).board.busy).toBe(true)
  })
})

describe('보유 조각', () => {
  test.each([
    ['play1.png', ['ㄷ', 'ㄹ', 'ㅊ']],
    ['play2.png', ['ㄷ', 'ㄹ', '사용']],
    ['play3.png', ['ㅣ', '사용', 'ㅈ']],
    ['hover1.png', ['ㅣ', '사용', 'ㅈ']],
    ['clearpreview.png', ['ㅏ', 'ㅌ', 'ㅣ']],
    ['empty3.png', ['ㅌ', 'ㄹ', 'ㅏ']],
  ])('%s', (f, want) => {
    expect(names(read(f).cards)).toEqual(want)
  })
  test('선택한 카드', () => {
    expect(read('hover1.png').cards.map((c) => c.selected)).toEqual([true, false, false])
  })
})

describe('커서와 아이콘', () => {
  test('메이플 커서(흰 손)는 점 찍기 아이콘이 아니라 커서다', () => {
    const { board } = read('cursor.png')
    expect(board.cells[6 * 10 + 4]).toBe('cursor')
    expect(board.icons.map((i) => `${i.r},${i.c}`)).toEqual(['4,8', '10,8'])
  })
  test('블록 위에 남은 점 찍기 아이콘: 칸은 찬 것으로 읽는다', () => {
    const { board } = read('icon-over2.png')
    expect(board.cells[10 * 10 + 8]).toBe('icon-dot-on')
    expect((board.board[10] >> 8) & 1).toBe(1)
    expect(board.cells[4 * 10 + 8]).toBe('icon-dot')
    expect((board.board[4] >> 8) & 1).toBe(0)
  })
  test('블록 위에 남은 바꿔 뽑기 아이콘', () => {
    const { board } = read('icon-over1.png')
    expect(board.cells[7 * 10 + 1]).toBe('icon-swap-on')
    expect((board.board[7] >> 1) & 1).toBe(1)
  })
})

describe('능력 꽉 참 표시', () => {
  test('주황색 칸이면 꽉 참, 평소엔 아니다', async () => {
    const { readAbilityFull } = await import('../src/lib/vision/read')
    const at = (f: string) => { const img = load(f); return readAbilityFull(img, detectGrid(img)!) }
    expect(at('full.png')).toBe(true)
    for (const f of ['play1.png', 'play3.png', 'cursor.png', 'icon-over1.png', 'stuck-dot.png']) expect(at(f)).toBe(false)
  })
})


describe('아이콘 밑이 블록인가 (underOf)', () => {
  // 사람이 캡처를 눈으로 보고 확인한 정답. [파일, 행, 열, 블록 위인가]
  const cases: [string, number, number, boolean][] = [
    ['icon-on-block', 10, 2, true], ['icon-on-block2', 7, 6, true], ['icon-on-block2', 10, 2, true], ['icon-over2', 10, 8, true],
    ['cursor', 10, 8, true], ['count-off', 8, 6, true], ['icon-over1', 7, 1, true],
    ['icon-on-block', 7, 6, false], ['icons-missing', 10, 0, false], ['icons-missing', 11, 5, false], ['icons-missing', 13, 7, false],
    ['count-off', 1, 4, false], ['count-off', 7, 9, false], ['icon-over1', 4, 8, false], ['icon-over2', 4, 8, false],
    ['stuck-dot', 7, 4, false], ['stuck-dot', 13, 5, false], ['stuck-dot', 14, 6, false], ['cursor', 4, 8, false],
  ]
  test('캡처의 아이콘 칸 19개: 반짝여 밝아져도(0~80%) 같은 답이다', async () => {
    const { underOf, readCell } = await import('../src/lib/vision/read')
    for (const [f, r, c, on] of cases) {
      const img = load(`${f}.png`), g = detectGrid(img) as Grid
      for (const a of [0, 0.2, 0.35, 0.5, 0.65, 0.8]) {
        const u = underOf(whiten(img, g, r, c, a) as any, g, r, c)
        expect(on ? u > 0 : u < 0, `${f} (${r + 1},${c + 1}) 밝기 ${a}: ${u}`).toBe(true)
      }
      // 20%만 밝아져도 예전 판별은 뒤집혔다 (실제 화면에서 블록 위 아이콘을 빈칸으로 알던 원인)
      const st = readCell(whiten(img, g, r, c, 0.2) as any, g, r, c)
      if (st.startsWith('icon')) expect(st.endsWith('-on'), `${f} (${r + 1},${c + 1})`).toBe(on)
    }
  })
  test('아이콘 없는 칸에서도 블록은 블록, 빈칸은 빈칸이다 (파랑 블록 포함)', async () => {
    const { underOf } = await import('../src/lib/vision/read')
    const wrong: string[] = []
    let n = 0
    for (const f of ['play1', 'play2', 'play3', 'count-off', 'icons-missing', 'icon-on-block', 'icon-on-block2', 'stuck-dot', 'full']) {
      const img = load(`${f}.png`), g = detectGrid(img) as Grid
      readBoard(img, g).cells.forEach((s, i) => {
        if (s !== 'block' && s !== 'empty') return
        n++
        const u = underOf(img, g, Math.floor(i / 10), i % 10)
        if (s === 'block' ? u <= 0 : u >= 0) wrong.push(`${f} ${Math.floor(i / 10) + 1},${(i % 10) + 1} ${s} → ${u}`)
      })
    }
    expect(n).toBeGreaterThan(1000)
    expect(wrong).toEqual([])
  })
})
