<script lang="ts">
  import { slide, fade } from 'svelte/transition'
  import { engine } from '../engine.svelte'
  import { PIECES } from '../core/pieces'
  import { seenIn } from '../core/stats'
  import MiniShape from './MiniShape.svelte'
  import IconChart from '~icons/lucide/chart-column'
  import IconCopy from '~icons/lucide/copy'
  import IconCheck from '~icons/lucide/check'
  import IconTrash from '~icons/lucide/trash-2'
  import IconChevron from '~icons/lucide/chevron-down'

  /*
   * 실제 게임에서 나온 조각 통계. 공식 확률이 비공개라서 직접 모은다.
   * 고른 확률(19종 각 5.3%)과 비교되게 막대 위에 기준선을 긋는다.
   */

  const PIECE_COLORS: Record<string, string> = { pink: '#f472b6', green: '#84cc16', blue: '#38bdf8', yellow: '#facc15' }
  const UNIFORM = 1 / PIECES.length

  let open = $state(false)
  let stage = $state(engine.stage)
  let copied = $state(false)
  let confirmReset = $state(false)

  const counts = $derived(engine.pieceCounts[stage] ?? {})
  const total = $derived(seenIn(engine.pieceCounts, stage))
  const max = $derived(Math.max(UNIFORM * 1.6, ...PIECES.map((p) => (total ? (counts[p.id] ?? 0) / total : 0))))
  const allTotal = $derived([1, 2, 3, 4, 5].reduce((a, s) => a + seenIn(engine.pieceCounts, s), 0))
  const games = $derived([...(engine.games.current ? [engine.games.current] : []), ...engine.games.past])
  const best = $derived(Math.max(0, ...games.filter((g) => g.fromStart).map((g) => g.score)))
  const fmtDate = (t: number) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  async function copy() {
    const data = {
      note: '모아모아 조각 통계 (단계 → 조각 id → 나온 횟수)',
      pieces: Object.fromEntries(PIECES.map((p) => [p.id, `${p.name} ${p.shape.cells}칸`])),
      counts: engine.pieceCounts,
      games,
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(data))
      copied = true
      setTimeout(() => (copied = false), 1800)
    } catch {
      engine.error = '클립보드에 복사하지 못했어요. 브라우저 권한을 확인해 주세요.'
    }
  }

  function reset() {
    if (!confirmReset) { confirmReset = true; setTimeout(() => (confirmReset = false), 3000); return }
    engine.resetStats()
    engine.resetGames()
    confirmReset = false
  }
</script>

<div class="panel overflow-hidden">
  <button class="flex w-full items-center justify-between p-4 text-sm" onclick={() => { open = !open; stage = engine.stage }}>
    <span class="flex items-center gap-2 text-ink-300"><IconChart class="size-4" />조각 통계</span>
    <span class="flex items-center gap-3 text-xs text-ink-500">
      {games.length}판{best ? ` · 최고 ${best.toLocaleString()}` : ''} · 조각 {allTotal}개
      <IconChevron class="size-4 transition-transform {open ? 'rotate-180' : ''}" />
    </span>
  </button>

  {#if open}
    <div class="px-4 pb-4" transition:slide>
      <p class="mb-3 text-[11px] leading-relaxed text-ink-500">
        화면 공유 중 새 세트가 뜰 때마다 단계별로 셉니다. 단계는 '제거한 줄 수'로 정해지니, 새 게임은 처음부터 공유해 주세요
        (판이 비면 자동으로 0부터 셉니다). 단계마다 100세트쯤 모이면 꽤 믿을 만해요.
      </p>

      <p class="mb-2 text-xs font-medium text-ink-300">판 기록</p>
      {#if games.length}
        <div class="mb-5 overflow-hidden rounded-xl border border-fg/5">
          <table class="w-full text-xs">
            <thead class="bg-fg/[0.03] text-ink-400">
              <tr><th class="px-2 py-1.5 text-left font-normal">언제</th><th class="px-2 text-right font-normal">점수</th><th class="px-2 text-right font-normal">줄</th><th class="px-2 text-right font-normal">세트</th><th class="px-2 text-right font-normal">2·3·4·5줄</th></tr>
            </thead>
            <tbody class="font-mono">
              {#each games.slice(0, 12) as g, i (g.start)}
                <tr class="border-t border-fg/5" class:text-s1={g.fromStart && g.score === best}>
                  <td class="px-2 py-1.5 font-sans text-ink-300">
                    {fmtDate(g.start)}{#if i === 0 && engine.games.current === g}<span class="ml-1 text-s1">진행 중</span>{/if}{#if !g.fromStart}<span class="ml-1 text-ink-500" title="중간부터 공유해서 앞부분이 빠졌어요">중간부터</span>{/if}
                  </td>
                  <td class="px-2 text-right text-ink-100">{g.score.toLocaleString()}</td>
                  <td class="px-2 text-right">{g.lines}</td>
                  <td class="px-2 text-right">{g.sets}</td>
                  <td class="px-2 text-right text-ink-400">{g.clears.slice(2).join('·')}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="-mt-3 mb-5 text-[11px] text-ink-500">점수는 판 변화로 센 값이에요. 게임 화면 점수와 다르면 놓친 배치가 있다는 뜻이니 알려 주세요.</p>
      {:else}
        <p class="mb-5 rounded-xl bg-fg/[0.03] p-3 text-center text-xs text-ink-400">화면 공유 중에 새 게임을 시작하면 판마다 기록돼요</p>
      {/if}

      <p class="mb-2 text-xs font-medium text-ink-300">조각 출현 빈도</p>
      <div class="mb-3 flex gap-1.5">
        {#each [1, 2, 3, 4, 5] as s (s)}
          <button class="tab" class:active={stage === s} onclick={() => (stage = s)}>
            {s}단계 <span class="font-mono opacity-70">{seenIn(engine.pieceCounts, s)}</span>
          </button>
        {/each}
      </div>

      {#if total}
        <ul class="grid gap-1.5" in:fade={{ duration: 150 }}>
          {#each PIECES as p (p.id)}
            {@const n = counts[p.id] ?? 0}
            {@const ratio = n / total}
            <li class="grid grid-cols-[2.2rem_3.2rem_1fr_4.5rem] items-center gap-2 text-xs">
              <span class="grid h-7 place-items-center rounded-md bg-ink-900">
                <MiniShape shape={p.shape} color={PIECE_COLORS[p.color]} cell={Math.max(2, Math.floor(20 / Math.max(p.shape.w, p.shape.h)) - 1)} gap={1} />
              </span>
              <span class="truncate text-ink-300">{p.name} <span class="text-ink-500">{p.shape.cells}</span></span>
              <span class="relative h-2 rounded-full bg-fg/5">
                <span class="absolute inset-y-0 left-0 rounded-full" style="width:{(ratio / max) * 100}%;background:{PIECE_COLORS[p.color]}"></span>
                <span class="absolute -inset-y-1 w-px bg-ink-400" style="left:{(UNIFORM / max) * 100}%" title="고른 확률 5.3%"></span>
              </span>
              <span class="text-right font-mono text-ink-200">{(ratio * 100).toFixed(1)}% <span class="text-ink-500">{n}</span></span>
            </li>
          {/each}
        </ul>
        <p class="mt-2 text-[11px] text-ink-500">세로선은 19종이 고르게 나올 때(5.3%)예요.</p>
      {:else}
        <p class="rounded-xl bg-fg/[0.03] p-4 text-center text-xs text-ink-400">{stage}단계에서 모은 조각이 아직 없어요</p>
      {/if}

      <div class="mt-4 flex flex-wrap gap-2">
        <button class="mini" onclick={copy} disabled={!allTotal && !games.length}>
          {#if copied}<IconCheck class="size-3.5" />복사했어요{:else}<IconCopy class="size-3.5" />기록 복사 (JSON){/if}
        </button>
        <button class="mini danger" class:armed={confirmReset} onclick={reset} disabled={!allTotal && !games.length}>
          <IconTrash class="size-3.5" />{confirmReset ? '한 번 더 누르면 지워요' : '기록 지우기'}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .tab {
    flex: 1;
    padding: 0.4rem 0;
    border-radius: 0.6rem;
    font-size: 0.72rem;
    color: var(--color-ink-300);
    background: rgb(var(--fg) / 0.03);
    border: 1px solid rgb(var(--fg) / 0.06);
  }
  .tab.active { color: var(--color-ink-100); border-color: color-mix(in oklab, var(--color-s1) 50%, transparent); background: color-mix(in oklab, var(--color-s1) 10%, transparent); }
  .mini {
    display: inline-flex; align-items: center; gap: 0.35rem; height: 2rem; padding: 0 0.75rem; border-radius: 0.65rem;
    font-size: 0.78rem; font-weight: 600; color: var(--color-ink-200);
    background: rgb(var(--fg) / 0.05); border: 1px solid rgb(var(--fg) / 0.08);
  }
  .mini:disabled { opacity: 0.4; }
  .mini.danger.armed { color: var(--color-s3); border-color: color-mix(in oklab, var(--color-s3) 50%, transparent); }
</style>
