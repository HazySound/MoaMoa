/**
 * 위쪽 표시줄 숫자 읽기 ('점수', '제거한 줄 수', '최고 점수'). 캡처마다 사람이 눈으로 읽은 값과 맞는지 본다.
 * 0~9가 모두 들어 있다 (칸 36.6px·48.8px 두 크기).
 */
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { describe, expect, test } from 'vitest'
import { detectGrid } from '../src/lib/vision/read'
import { readTopBar } from '../src/lib/vision/topbar'

const truth: [string, number, number, number][] = [
  ['clearpreview', 425, 1, 7205], ['count-off', 33068, 77, 33068], ['cursor', 8848, 22, 8848], ['empty3', 0, 0, 7205],
  ['full', 11471, 30, 14053], ['hover1', 414, 1, 7205], ['hover2', 414, 1, 7205], ['icon-on-block', 73321, 176, 73321],
  ['icon-on-block2', 73638, 177, 73638], ['icon-over1', 5664, 14, 7205], ['icon-over2', 8848, 22, 8848],
  ['icons-missing', 19910, 49, 29182], ['play1', 39, 0, 7205], ['play2', 46, 0, 7205], ['play3', 414, 1, 7205], ['stuck-dot', 4348, 12, 7205],
]

describe('위쪽 표시줄 숫자', () => {
  for (const [file, score, lines, best] of truth) {
    test(`${file}: ${score} / ${lines} / ${best}`, () => {
      const img = PNG.sync.read(readFileSync(`test/fixtures/${file}.png`)) as any
      const g = detectGrid(img)!
      expect(readTopBar(img, g)).toEqual({ score, lines, best })
    })
  }
})
