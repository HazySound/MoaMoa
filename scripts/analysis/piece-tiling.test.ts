import { test } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { PIECES } from '../../src/lib/core/pieces'
import { orientations, type Shape } from '../../src/lib/core/board'
import { blendedWeights } from '../../src/lib/core/stats'

const byId = new Map(PIECES.map((p) => [p.id, p]))
const ORI = new Map(PIECES.map((p) => [p.id, orientations(p.shape).map((o) => o.shape)]))

/** h×w 직사각형을 조각 1~3개로 꼭 맞게 채우는 조합(이름 다중집합) */
function tilings(h: number, w: number, maxPieces: number): Map<string, number> {
  const out = new Map<string, number>()
  const full = (1 << w) - 1
  const rows = new Array(h).fill(0)
  const used: number[] = []
  const fits = (s: Shape, r: number, c: number) => { for (let i = 0; i < s.h; i++) if (rows[r + i] & (s.rows[i] << c)) return false; return true }
  const rec = () => {
    // 가장 먼저 비는 칸(위→아래, 왼→오른쪽)을 찾아 거기를 덮는 조각만 시도한다 (중복 없는 열거)
    let fr = -1, fc = -1
    for (let r = 0; r < h && fr < 0; r++) for (let c = 0; c < w; c++) if (!((rows[r] >> c) & 1)) { fr = r; fc = c; break }
    if (fr < 0) { const k = used.map((id) => byId.get(id)!.name).sort().join('+'); out.set(k, (out.get(k) ?? 0) + 1); return }
    if (used.length >= maxPieces) return
    for (const p of PIECES) {
      if (p.shape.cells === 1) continue
      for (const s of ORI.get(p.id)!) {
        // 조각의 첫 줄에서 가장 왼쪽 칸이 (fr, fc)에 오도록
        const lead = Math.log2(s.rows[0] & -s.rows[0]) | 0
        const r = fr, c = fc - lead
        if (c < 0 || c + s.w > w || r + s.h > h) continue
        if (!fits(s, r, c)) continue
        for (let i = 0; i < s.h; i++) rows[r + i] |= s.rows[i] << c
        used.push(p.id); rec(); used.pop()
        for (let i = 0; i < s.h; i++) rows[r + i] &= ~(s.rows[i] << c)
      }
    }
  }
  rec()
  return out
}

test('tiling', () => {
  const counts = JSON.parse(readFileSync('docs/data/piece-stats-2026-10-03.json', 'utf8')).counts
  const w5 = blendedWeights(counts, 5)
  const freq = (name: string) => { const p = PIECES.find((x) => x.name === name)!; return w5.get(p.id) ?? 0 }
  const lines: string[] = []
  for (const h of [2, 3, 4, 5]) for (const w of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const t = tilings(h, w, 3)
    if (!t.size) continue
    // 조합의 단계 5 등장 확률(조각 빈도 곱, 순서 무시)로 정렬
    const rows = [...t].map(([k]) => {
      const names = k.split('+')
      const p = names.reduce((a, n) => a * freq(n), 1)
      return { k, n: names.length, p }
    }).sort((a, b) => b.p - a.p)
    lines.push(`## ${h}×${w} (${h * w}칸): ${rows.length}가지`)
    for (const r of rows.slice(0, 14)) lines.push(`- ${r.k}  (조각 ${r.n}, 단계5 빈도곱 ${(r.p * 1e4).toFixed(2)}‱)`)
  }
  writeFileSync('C:/Users/cho/AppData/Local/Temp/claude/C--Simon/42335e66-c16e-424f-a90b-166fffb8c2e5/scratchpad/tilings.md', lines.join('\n'))
  console.log(lines.length, 'lines')
  // 단계 5 빈도표
  console.log([...w5].map(([id, v]) => `${byId.get(id)!.name}:${(v * 100).toFixed(1)}%`).join(' '))
}, 600000)

test('deeper', () => {
  const counts = JSON.parse(readFileSync('docs/data/piece-stats-2026-10-03.json', 'utf8')).counts
  const w5 = blendedWeights(counts, 5)
  const nameOf = (id: number) => byId.get(id)!.name
  const freq = (name: string) => { const p = PIECES.find((x) => x.name === name)!; return w5.get(p.id) ?? 0 }
  const lines: string[] = []
  // 1) 높이 2·3, 너비 ≤10, 조각 ≤4개
  const pairs = new Map<string, string[]>() // 조각 → 같이 직사각형을 이루는 상대 (2조각)
  for (const h of [2, 3]) for (let w = 2; w <= 10; w++) {
    const t = tilings(h, w, 4)
    if (!t.size) continue
    const rows = [...t].map(([k]) => { const names = k.split('+'); return { k, n: names.length, p: names.reduce((a, n) => a * freq(n), 1) } }).sort((a, b) => b.p - a.p)
    lines.push(`## ${h}×${w} (${h * w}칸): ${rows.length}가지`)
    for (const r of rows.slice(0, 12)) lines.push(`- ${r.k}  (조각 ${r.n}, 빈도곱 ${(r.p * 1e4).toFixed(2)}‱)`)
    for (const r of rows) if (r.n === 2) { const [a, b] = r.k.split('+'); for (const [x, y] of [[a, b], [b, a]]) { const l = pairs.get(x) ?? []; if (!l.includes(`${y}(${h}×${w})`)) l.push(`${y}(${h}×${w})`); pairs.set(x, l) } }
  }
  lines.push('\n## 조각별 2조각 직사각형 짝 (높이 2·3)')
  for (const p of PIECES) lines.push(`- ${p.name}(${p.shape.cells}, ${(freq(p.name) * 100).toFixed(1)}%): ${(pairs.get(p.name) ?? []).join(', ') || '없음'}`)
  // 2) 조각 안에 '갇힌 빈칸'(상하좌우가 모두 조각 칸)이 있는 조각 = 놓는 순간 고립 구멍
  lines.push('\n## 놓는 순간 고립 구멍이 생기는 조각 (조각 안에 사방이 막힌 빈칸)')
  for (const p of PIECES) {
    const s = p.shape; let holes = 0
    for (let r = 1; r < s.h - 1; r++) for (let c = 1; c < s.w - 1; c++) if (!((s.rows[r] >> c) & 1) && ((s.rows[r - 1] >> c) & 1) && ((s.rows[r + 1] >> c) & 1) && ((s.rows[r] >> (c - 1)) & 1) && ((s.rows[r] >> (c + 1)) & 1)) holes++
    if (holes) lines.push(`- ${p.name}: 구멍 ${holes}개 (빈도 ${(freq(p.name) * 100).toFixed(1)}%)`)
  }
  // 3) 단계 5에서 무작위 두 조각이 2조각 직사각형(높이 ≤3)을 이룰 확률, 세 조각 세트 안에 그런 짝이 있을 확률
  const pairSet = new Set<string>()
  for (const [a, l] of pairs) for (const b of l) pairSet.add(a + '+' + b.replace(/\(.*\)/, ''))
  const ids = PIECES.map((p) => p.id)
  let pPair = 0
  for (const a of ids) for (const b of ids) if (pairSet.has(nameOf(a) + '+' + nameOf(b))) pPair += (w5.get(a) ?? 0) * (w5.get(b) ?? 0)
  let pSet = 0
  for (const a of ids) for (const b of ids) for (const c of ids) {
    const ok = pairSet.has(nameOf(a) + '+' + nameOf(b)) || pairSet.has(nameOf(a) + '+' + nameOf(c)) || pairSet.has(nameOf(b) + '+' + nameOf(c))
    if (ok) pSet += (w5.get(a) ?? 0) * (w5.get(b) ?? 0) * (w5.get(c) ?? 0)
  }
  lines.push(`\n## 확률 (단계 5)\n- 무작위 두 조각이 2조각 직사각형(높이 2·3)을 이룰 확률: ${(pPair * 100).toFixed(1)}%\n- 세 조각 세트 안에 그런 짝이 하나라도 있을 확률: ${(pSet * 100).toFixed(1)}%`)
  writeFileSync('C:/Users/cho/AppData/Local/Temp/claude/C--Simon/42335e66-c16e-424f-a90b-166fffb8c2e5/scratchpad/tilings2.md', lines.join('\n'))
  console.log('done', lines.length)
}, 900000)
