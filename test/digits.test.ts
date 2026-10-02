/**
 * 오른쪽 '보유 능력' 칸 숫자 읽기. 캡처마다 사람이 눈으로 읽은 값과 맞는지 본다.
 * 칸 36.6px(작은 창) · 48.8px(큰 창) 캡처가 섞여 있다.
 */
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { describe, expect, test } from 'vitest'
import { detectGrid } from '../src/lib/vision/read'
import { readAbilityNumbers } from '../src/lib/vision/digits'

// [파일, 점 찍기, 바꿔 뽑기, 다음 능력, 보유 개수] — null: 그 자리에 숫자가 없다 (full: 능력 꽉 참 주황 칸)
const truth: [string, number, number, number | null, number | null][] = [
  ['clearpreview', 0, 1, 2, 1], ['count-off', 3, 2, 2, 5], ['cursor', 1, 3, 1, 4], ['empty3', 0, 0, 7, 0],
  ['full', 1, 6, null, null], ['icon-over1', 1, 1, 2, 2], ['icon-over2', 1, 3, 1, 4], ['icons-missing', 3, 2, 4, 5],
  ['play1', 0, 0, 1, 0], ['play2', 0, 0, 7, 0], ['play3', 0, 1, 4, 1], ['stuck-dot', 0, 0, 2, 0],
  ['hover1', 0, 1, 4, 1], ['hover2', 0, 1, 4, 1],
]

describe('능력 숫자 읽기', () => {
  for (const [file, dots, swaps, next, held] of truth) {
    test(file, () => {
      const img = PNG.sync.read(readFileSync(`test/fixtures/${file}.png`)) as any
      const g = detectGrid(img)!
      expect(readAbilityNumbers(img, g)).toEqual({ dots, swaps, next, held })
    })
  }
})
