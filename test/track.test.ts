import { describe, expect, test } from 'vitest'
import { parseBoard, orientations } from '../src/lib/core/board'
import { PIECES } from '../src/lib/core/pieces'
import { explainMove } from '../src/lib/core/track'

const piece = (name: string) => PIECES.find((p) => p.name === name)!.shape

describe('판 변화 풀기', () => {
  const prev = parseBoard(`
    ..........
    #########.
    #########.`)
  test('조각 하나를 놓고 줄이 지워진 변화', () => {
    // ㅣ를 세로로 9열에 놓으면 아래 두 줄이 지워지고 맨 위 세 칸만 남는다
    const next = parseBoard(`
      .........#
      .........#
      .........#
      ..........
      ..........`)
    const m = explainMove(prev, next, [{ slot: 0, shape: piece('ㄷ') }, { slot: 1, shape: piece('ㅣ') }], false)
    expect(m?.slot).toBe(1)
    expect(m?.cleared).toEqual([14, 15])
  })
  test('손에 없는 모양이면 풀지 못한다 (커서·반짝임으로 잘못 읽은 판)', () => {
    const next = parseBoard(`
      ....#.....
      #########.
      #########.`)
    expect(explainMove(prev, next, [{ slot: 0, shape: piece('ㄷ') }], false)).toBeNull()
  })
  test('점 찍기 한 칸', () => {
    const next = parseBoard(`
      ....#.....
      #########.
      #########.`)
    expect(explainMove(prev, next, [{ slot: 0, shape: piece('ㄷ') }], true)?.slot).toBe(-1)
  })
  test('화면의 카드가 돌아가 있어도 같은 조각으로 푼다', () => {
    const rotated = orientations(piece('ㅣ'))[1].shape
    const next = parseBoard(`
      #####.....
      #########.
      #########.`)
    expect(explainMove(prev, next, [{ slot: 2, shape: rotated }], false)?.slot).toBe(2)
  })
})

import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { detectGrid, readBoard, readCards } from '../src/lib/vision/read'

describe('실제 캡처로 판 변화 풀기', () => {
  const read = (f: string) => {
    const img = PNG.sync.read(readFileSync(`test/fixtures/${f}`))
    const g = detectGrid(img)!
    return { board: readBoard(img, g), cards: readCards(img, g) }
  }
  test('플레이1 → 플레이2: 3번 카드 ㅊ을 놓았다', () => {
    const a = read('play1.png'), b = read('play2.png')
    const hand = a.cards.map((c, slot) => ({ slot, shape: c.shape! }))
    const m = explainMove(a.board.board, b.board.board, hand, true)
    expect(m?.slot).toBe(2)
  })
  test('점 찍기 아이콘이 반짝이는 판도 읽는다', () => {
    const s = read('stuck-dot.png')
    expect(s.board.icons.filter((i) => i.kind === 'dot').length).toBe(2)
    expect(s.board.icons.filter((i) => i.kind === 'swap').length).toBe(1)
    expect(s.board.obscured).toBe(false)
    expect(s.cards.map((c) => c.state)).toEqual(['piece', 'piece', 'piece'])
  })
})

describe('못 읽은 칸', () => {
  test('커서에 가린 칸은 어느 쪽이든 맞는 것으로 보고 풀고, 실제 판을 돌려준다', () => {
    const prev = parseBoard('..........')
    // ㅡ를 맨 아래 0~2열에 놓았는데 1열이 커서에 가려 빈칸으로 읽혔다
    const seen = parseBoard('#.#.......')
    const unsure = new Array(16).fill(0); unsure[15] = 1 << 1
    expect(explainMove(prev, seen, [{ slot: 0, shape: piece('ㅡ') }], false)).toBeNull()
    const m = explainMove(prev, seen, [{ slot: 0, shape: piece('ㅡ') }], false, unsure)
    expect(m?.slot).toBe(0)
    expect(m?.board[15]).toBe(0b111)
  })
})

describe('화면 공유에서 잘라 읽는 영역', () => {
  test('위쪽 표시줄(판 위 -1.55칸)과 오른쪽 능력 칸(14.5칸)까지 들어간다 (전에는 위로 1칸만 잘라 줄 수를 못 읽었다)', async () => {
    const { regionOf } = await import('../src/lib/capture')
    const g = { x: 100, y: 300, pitch: 40 }
    const r = regionOf(g)
    expect(r.y).toBeLessThanOrEqual(g.y - 1.6 * g.pitch)
    expect(r.x + r.w).toBeGreaterThanOrEqual(g.x + 14.6 * g.pitch)
    expect(r.y + r.h).toBeGreaterThanOrEqual(g.y + 16 * g.pitch)
  })
})
