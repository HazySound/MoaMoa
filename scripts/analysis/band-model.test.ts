import { test } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { PIECES } from '../../src/lib/core/pieces'
import { orientations, type Shape } from '../../src/lib/core/board'
import { blendedWeights } from '../../src/lib/core/stats'

/**
 * 띠(높이 H) 모델 2판. 창(너비 W) 안 칸 상태가 '상태'. 왼쪽 열이 다 차면 창을 민다.
 * '죽음' = 창 안에 사방이 막힌 빈칸(점 찍기로만 메울 수 있는 구멍)이 생김 → 벌점 D를 받고 빈 띠에서 다시 시작.
 * 조각마다 '놓침'(다른 띠로 보냄, 보상 0, 상태 그대로)과 창 안 자리들 중 최선을 고른다.
 * 결과: 조각당 흡수 칸(처리량), 놓침 비율, 조각당 죽을 확률, 자주 머무는 모양, 빈 띠에서 조각별 첫 자리
 */
function analyze(H: number, W: number, weights: Map<number, number>, D = 50, gamma = 0.95, iters = 60) {
  const ORI: { id: number; s: Shape }[] = []
  for (const p of PIECES) for (const s of orientations(p.shape).map((o) => o.shape)) if (s.h <= H && s.w <= W) ORI.push({ id: p.id, s })
  const ids = PIECES.map((p) => p.id)
  const cellsOf = new Map(PIECES.map((p) => [p.id, p.shape.cells]))
  const wOf = (id: number) => weights.get(id) ?? 0
  const N = 1 << (H * W), full = (1 << W) - 1
  const rowOf = (st: number, r: number) => (st >> (r * W)) & full
  const norm = (st: number) => { for (;;) { let all = true; for (let r = 0; r < H; r++) if (!(rowOf(st, r) & 1)) { all = false; break } if (!all) return st; let n = 0; for (let r = 0; r < H; r++) n |= (rowOf(st, r) >> 1) << (r * W); st = n } }
  const dead = (st: number) => {
    for (let r = 0; r < H; r++) for (let c = 0; c < W - 1; c++) {
      if ((rowOf(st, r) >> c) & 1) continue
      const left = c === 0 ? true : !!((rowOf(st, r) >> (c - 1)) & 1)
      const right = !!((rowOf(st, r) >> (c + 1)) & 1)
      const up = r === 0 ? true : !!((rowOf(st, r - 1) >> c) & 1)
      const down = r === H - 1 ? true : !!((rowOf(st, r + 1) >> c) & 1)
      if (left && right && up && down) return true
    }
    return false
  }
  const isDead = new Uint8Array(N); for (let st = 0; st < N; st++) isDead[st] = dead(st) ? 1 : 0
  // 자식 목록
  const children: Int32Array[] = [], childIdx: Int32Array[] = []
  ids.forEach((id, k) => {
    const list: number[] = [], idx = new Int32Array(N + 1), oris = ORI.filter((o) => o.id === id)
    for (let st = 0; st < N; st++) {
      idx[st] = list.length
      const seen = new Set<number>()
      for (const { s } of oris) for (let r = 0; r + s.h <= H; r++) for (let c = 0; c + s.w <= W; c++) {
        let ok = true, n = st
        for (let i = 0; i < s.h && ok; i++) { const bits = (s.rows[i] << c) << ((r + i) * W); if (n & bits) ok = false; else n |= bits }
        if (!ok) continue
        const m = norm(n); if (!seen.has(m)) { seen.add(m); list.push(m) }
      }
    }
    idx[N] = list.length; children[k] = Int32Array.from(list); childIdx[k] = idx
  })
  let V = new Float32Array(N)
  const val = (s2: number, V: Float32Array) => (isDead[s2] ? -D + gamma * V[0] : gamma * V[s2])
  for (let it = 0; it < iters; it++) {
    const NV = new Float32Array(N)
    for (let st = 0; st < N; st++) {
      if (isDead[st]) continue
      let v = 0
      ids.forEach((id, k) => {
        let best = gamma * V[st] // 놓침
        const a = childIdx[k][st], b = childIdx[k][st + 1], cells = cellsOf.get(id)!
        for (let i = a; i < b; i++) { const x = cells + val(children[k][i], V); if (x > best) best = x }
        v += wOf(id) * best
      })
      NV[st] = v
    }
    V = NV
  }
  // 정상 분포 (죽으면 빈 띠로)
  let dist = new Float64Array(N); dist[0] = 1
  let miss = 0, deathP = 0, absorbed = 0
  const missBy = new Map<number, number>()
  for (let it = 0; it < 400; it++) {
    const nd = new Float64Array(N); miss = 0; deathP = 0; absorbed = 0; missBy.clear()
    for (let st = 0; st < N; st++) {
      const p = dist[st]; if (p < 1e-13) continue
      ids.forEach((id, k) => {
        const w = wOf(id); if (!w) return
        let best = gamma * V[st], bs = -1
        const a = childIdx[k][st], b = childIdx[k][st + 1], cells = cellsOf.get(id)!
        for (let i = a; i < b; i++) { const x = cells + val(children[k][i], V); if (x > best) { best = x; bs = children[k][i] } }
        if (bs < 0) { nd[st] += p * w; miss += p * w; missBy.set(id, (missBy.get(id) ?? 0) + p * w) }
        else if (isDead[bs]) { nd[0] += p * w; deathP += p * w; absorbed += p * w * cells }
        else { nd[bs] += p * w; absorbed += p * w * cells }
      })
    }
    dist = nd
  }
  const draw = (st: number) => Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => ((rowOf(st, r) >> c) & 1 ? '#' : '.')).join('')).join(' / ')
  const top = [...dist].map((p, st) => ({ p, st })).sort((a, b) => b.p - a.p).slice(0, 10).map((t) => `${(t.p * 100).toFixed(1)}% ${draw(t.st)}`)
  // 빈 띠에서 조각별 첫 자리
  const first: string[] = []
  ids.forEach((id, k) => {
    const w = wOf(id); if (w < 0.02) return
    let best = gamma * V[0], bs = -1
    const a = childIdx[k][0], b = childIdx[k][1], cells = cellsOf.get(id)!
    for (let i = a; i < b; i++) { const x = cells + val(children[k][i], V); if (x > best) { best = x; bs = children[k][i] } }
    first.push(`${PIECES.find((x) => x.id === id)!.name}(${(w * 100).toFixed(1)}%): ${bs < 0 ? '놓침(다른 띠로)' : draw(bs)}`)
  })
  const name = (id: number) => PIECES.find((x) => x.id === id)!.name
  return { miss, deathP, absorbed, missBy: [...missBy].sort((a, b) => b[1] - a[1]).map(([id, p]) => `${name(id)} ${(p * 100).toFixed(1)}%`), top, first }
}

test('band2', () => {
  const counts = JSON.parse(readFileSync('docs/data/piece-stats-2026-10-03.json', 'utf8')).counts
  const w5 = blendedWeights(counts, 5)
  const out: string[] = []
  for (const [H, W] of [[2, 6], [3, 6], [4, 5], [5, 4]] as const) {
    const t0 = Date.now()
    const r = analyze(H, W, w5)
    out.push(`## 띠 높이 ${H} (창 ${W}) — ${((Date.now() - t0) / 1000).toFixed(0)}초`)
    out.push(`- 조각당 흡수 칸(처리량): ${r.absorbed.toFixed(2)} / 놓침(다른 띠로): ${(r.miss * 100).toFixed(1)}% / 조각당 죽을 확률: ${(r.deathP * 100).toFixed(2)}% (${r.deathP > 0 ? (1 / r.deathP).toFixed(0) : '∞'}조각마다 한 번)`)
    out.push(`- 놓치는 조각: ${r.missBy.join(', ')}`)
    out.push(`- 자주 머무는 모양:\n  - ${r.top.join('\n  - ')}`)
    out.push(`- 빈 띠에서 첫 조각 자리:\n  - ${r.first.join('\n  - ')}`)
    console.log(out.slice(-5).join('\n'))
  }
  writeFileSync('C:/Users/cho/AppData/Local/Temp/claude/C--Simon/42335e66-c16e-424f-a90b-166fffb8c2e5/scratchpad/band2.md', out.join('\n'))
}, 1800000)

test('chain', () => {
  const counts = JSON.parse(readFileSync('docs/data/piece-stats-2026-10-03.json', 'utf8')).counts
  const w5 = blendedWeights(counts, 5)
  const name = (id: number) => PIECES.find((x) => x.id === id)!.name
  const out: string[] = []
  for (const chain of [[[3, 6], [3, 6], [4, 5]], [[4, 5], [3, 6], [3, 6]], [[3, 6], [4, 5], [5, 4]]] as const) {
    let w = new Map(w5)
    let total = 1, absorbedCells = 0
    out.push(`## 띠 사슬 ${chain.map(([h]) => `높이${h}`).join(' → ')}`)
    for (const [H, W] of chain) {
      const mass = [...w.values()].reduce((a, b) => a + b, 0)
      const wn = new Map([...w].map(([k, v]) => [k, v / mass]))
      const r0 = analyze(H, W, wn)
      const r = { ...r0, miss: r0.miss * mass, absorbed: r0.absorbed * mass, missBy: r0.missBy.map((x) => { const [n, pc] = x.split(' '); return n + ' ' + (parseFloat(pc) * mass).toFixed(1) + '%' }) }
      // 이 띠가 받은 조각 중 흡수한 비율
      const absorbedFrac = 1 - r.miss / mass
      absorbedCells += r.absorbed
      out.push(`- 높이 ${H}: 받은 조각 ${(mass * 100).toFixed(1)}% 중 ${(absorbedFrac * 100).toFixed(0)}% 흡수 → 남는 조각 ${(r.miss * 100).toFixed(1)}%. 많이 남는 것: ${r.missBy.slice(0, 6).join(', ')}`)
      // 다음 띠로 넘길 분포 = 놓친 조각
      const next = new Map<number, number>()
      for (const s of r.missBy) { const [n, p] = s.split(' '); const id = PIECES.find((x) => x.name === n)!.id; next.set(id, parseFloat(p) / 100) }
      w = next
      total = r.miss
    }
    out.push(`- 세 띠를 거친 뒤 남는 조각: ${(total * 100).toFixed(1)}% (세트당 ${(total * 3).toFixed(2)}개), 조각당 흡수 칸 합계 ${absorbedCells.toFixed(2)} (조각 평균 6.15칸)`)
  }
  console.log(out.join('\n'))
  writeFileSync('C:/Users/cho/AppData/Local/Temp/claude/C--Simon/42335e66-c16e-424f-a90b-166fffb8c2e5/scratchpad/band-chain.md', out.join('\n'))
}, 1800000)
