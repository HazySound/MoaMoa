/**
 * 화면 숫자 모양으로 개수 정하기 (core/counts.ts). 가짜 모양으로 상황을 만든다:
 * 모양은 숫자마다 뚜렷이 다르고, guess는 '획 구조 짐작'이 낸 값이다 (틀리게도 만들 수 있다).
 */
import { describe, expect, test } from 'vitest'
import { ScreenCounts } from '../src/lib/core/counts'
import type { Glyph, GlyphReads } from '../src/lib/vision/digits'

/** 숫자 shape처럼 생긴 모양. guess를 따로 주면 구조 짐작이 틀린 경우다 */
const gl = (shape: number, guess = shape): Glyph => {
  const f = new Array(36).fill(0)
  f[shape] = 10
  return { f, guess, art: `모양${shape}` }
}
const reads = (dots: Glyph | null, swaps: Glyph | null, held: Glyph | null, next: Glyph | null = null): GlyphReads => ({ dots, swaps, held, next, why: {} })
const feed = (sc: ScreenCounts, r: GlyphReads, full = false, n = 3) => {
  const ev = []
  for (let i = 0; i < n; i++) ev.push(...sc.feed(r, full, 3))
  return ev
}

describe('화면 숫자로 개수 정하기', () => {
  test('같은 모양이 3프레임 이어져야 받아들인다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(3), gl(2), gl(5)), false, 2)
    expect(sc.dots).toBeNull()
    feed(sc, reads(gl(3), gl(2), gl(5)), false, 1)
    expect([sc.dots, sc.swaps]).toEqual([3, 2])
    expect(sc.countsFresh).toBe(true)
  })

  test('보유가 꽉 차면(주황 칸) 보유 7로 검산한다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(1), gl(6), null), true)
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([1, 6, false])
  })

  test('처음 보는 숫자를 구조 짐작이 틀려도, 합으로 알아내고 그 모양을 배운다 (보유 6개에서 틀어지던 원인)', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(3), gl(2), gl(5)))
    // 점 찍기를 하나 얻어 4가 됐다. 버튼의 4는 처음 보는 모양이고 구조 짐작은 7이라고 한다. 보유는 6
    const four = gl(4, 7)
    const ev = feed(sc, reads(four, gl(2), gl(6)))
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([4, 2, false])
    expect(ev.map((e) => e.what)).toEqual(['합으로 알아냄'])
    // 그다음부터는 그 모양을 4로 안다: 바꿔 뽑기도 같이 바뀌어도 맞춘다
    feed(sc, reads(four, gl(3), gl(7, 7)), true)
    expect([sc.dots, sc.swaps]).toEqual([4, 3])
    // 보유 칸이 안 보여도 (가려짐) 배운 모양이면 받는다
    feed(sc, reads(gl(3), gl(3), gl(6)))
    feed(sc, reads(four, gl(3), null), false, 12)
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([4, 3, false])
  })

  test('못 정하면 값을 바꾸지 않고 모름만 알린다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(3), gl(2), gl(5)))
    // 두 버튼이 한꺼번에 처음 보는 모양으로 바뀌고 합도 안 맞는다
    const ev = feed(sc, reads(gl(4, 7), gl(5, 3), gl(1)))
    expect([sc.dots, sc.swaps]).toEqual([3, 2])
    expect(sc.unsure).toBe(true)
    expect(sc.countsFresh).toBe(false)
    expect(ev.map((e) => e.what)).toEqual(['화면 숫자 못 정함'])
    // 다시 읽히면 풀린다
    feed(sc, reads(gl(3), gl(2), gl(5)))
    expect(sc.unsure).toBe(false)
  })

  test('버튼이 가려진 동안(모양 없음)은 값을 그대로 둔다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(3), gl(2), gl(5)))
    feed(sc, reads(null, gl(2), gl(5)), false, 20)
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([3, 2, false])
    expect(sc.countsFresh).toBe(false)
  })

  test('보유 숫자를 잘못 짐작해도, 확인된 두 버튼을 믿는다', () => {
    const sc = new ScreenCounts()
    feed(sc, reads(gl(1), gl(1), gl(2)))
    feed(sc, reads(gl(1), gl(2), gl(3)))
    feed(sc, reads(gl(2), gl(2), gl(4)))
    feed(sc, reads(gl(2), gl(1), gl(3)))
    // 판넬의 6은 캡처가 없는 숫자다. 구조 짐작이 3이라고 틀려도 버튼 2 + 1... 이 아니라 확인된 3 + 3을 믿는다
    feed(sc, reads(gl(3), gl(2), gl(5)))
    feed(sc, reads(gl(3), gl(3), gl(6, 3)))
    expect([sc.dots, sc.swaps, sc.unsure]).toEqual([3, 3, false])
  })

  test('기억한 모양끼리 합이 안 맞으면 기억을 지우고 다시 배운다', () => {
    const sc = new ScreenCounts()
    // 잘못 배운 기억: 모양 4를 5로 (서로 다른 상황 두 번 = 확실)
    sc.memory.dots.push({ f: gl(4).f, digit: 5, ctx: ['a', 'b'] })
    sc.memory.swaps.push({ f: gl(2).f, digit: 2, ctx: ['a', 'b'] })
    sc.memory.held.push({ f: gl(6).f, digit: 6, ctx: ['a', 'b'] })
    const ev = feed(sc, reads(gl(4), gl(2), gl(6)))
    expect(ev.map((e) => e.what)).toEqual(['화면 숫자 안 맞음'])
    expect(sc.unsure).toBe(true)
    expect(sc.memory.dots.length).toBe(0)
  })

  test('다음 능력: 흐름(7 → 6 → … → 1 → 7)에 맞으면 처음 보는 모양도 받고 배운다', () => {
    const sc = new ScreenCounts()
    const b = reads(gl(0), gl(0), gl(0))
    feed(sc, { ...b, next: gl(7) })
    expect(sc.next).toBe(7)
    // 판넬의 6은 캡처가 없는 숫자지만 7 다음이라 받는다
    feed(sc, { ...b, next: gl(6) })
    expect(sc.next).toBe(6)
    feed(sc, { ...b, next: gl(5) })
    feed(sc, { ...b, next: gl(4) })
    // 3도 캡처가 없다. 구조 짐작이 엉뚱한 6을 내면(4 다음이 아니다) 받지 않는다
    const ev = feed(sc, { ...b, next: gl(3, 6) })
    expect(sc.next).toBe(4)
    expect(sc.nextFresh).toBe(false)
    expect(ev.map((e) => e.what)).toEqual(['다음 능력 숫자 못 읽음'])
  })
})
