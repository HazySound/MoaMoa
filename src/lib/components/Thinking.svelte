<script lang="ts">
  import { fade } from 'svelte/transition'
  import { Tween } from 'svelte/motion'
  import { cubicOut } from 'svelte/easing'

  /** 추천을 계산하는 동안 판 위에 덮는 진행 표시 */
  let { progress, compact = false }: { progress: number; compact?: boolean } = $props()

  const shown = new Tween(0, { duration: 160, easing: cubicOut })
  $effect(() => { shown.target = progress })

  const R = 26
  const C = 2 * Math.PI * R
</script>

<div class="veil" transition:fade={{ duration: 180 }} role="status" aria-live="polite">
  <div class="flex flex-col items-center gap-2">
    <svg width={compact ? 56 : 68} height={compact ? 56 : 68} viewBox="0 0 64 64" class="-rotate-90">
      <circle cx="32" cy="32" r={R} fill="none" stroke="rgb(var(--fg) / 0.1)" stroke-width="5" />
      <circle
        cx="32" cy="32" r={R} fill="none" stroke="url(#thinking-grad)" stroke-width="5" stroke-linecap="round"
        stroke-dasharray={C} stroke-dashoffset={C * (1 - Math.max(0.03, shown.current))}
      />
      <defs>
        <linearGradient id="thinking-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="var(--color-s1)" />
          <stop offset="100%" stop-color="var(--color-s2)" />
        </linearGradient>
      </defs>
    </svg>
    <p class="text-center font-semibold {compact ? 'text-xs' : 'text-sm'}">최선의 수 찾는 중</p>
    <p class="-mt-1 font-mono text-[11px] text-ink-300">{Math.round(shown.current * 100)}%</p>
  </div>
</div>

<style>
  .veil {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    place-items: center;
    border-radius: inherit;
    background: color-mix(in oklab, var(--color-ink-950) 62%, transparent);
    backdrop-filter: blur(3px);
  }
</style>
