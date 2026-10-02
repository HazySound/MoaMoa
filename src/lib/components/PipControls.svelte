<script lang="ts">
  import { slide } from 'svelte/transition'
  import { engine } from '../engine.svelte'
  import IconSwap from '~icons/lucide/arrow-left-right'
  import IconDot from '~icons/lucide/circle-dot'
  import IconSettings from '~icons/lucide/settings-2'
  import IconRefresh from '~icons/lucide/refresh-cw'
  import IconChevron from '~icons/lucide/chevron-up'

  /*
   * 작은 창 아래쪽 설정. 게임을 보면서 바로 고칠 수 있게 원래 창의 설정을 모두 여기에도 둔다.
   * 능력 개수는 게임 화면 오른쪽 '보유 능력'과 다르면 여기서 맞춘다.
   */
  let open = $state(false)

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const steppers = [
    { label: '점 찍기', icon: IconDot, cls: 'text-sky-400', get: () => engine.dots, set: (v: number) => { engine.dots = clamp(v, 0, 7 - engine.swaps); engine.abilityUnsure = false } },
    { label: '바꿔 뽑기', icon: IconSwap, cls: 'text-violet-400', get: () => engine.swaps, set: (v: number) => { engine.swaps = clamp(v, 0, 7 - engine.dots); engine.abilityUnsure = false } },
    { label: '다음 능력', icon: null, cls: '', get: () => engine.nextAbility ?? 7, set: (v: number) => { engine.nextAbility = clamp(v, 1, 7); engine.nextUnsure = false } },
    { label: '지운 줄', icon: null, cls: '', get: () => engine.lines, set: (v: number) => (engine.lines = Math.max(0, v)) },
  ]
</script>

<div class="wrap">
  <button class="head" onclick={() => (open = !open)}>
    <span class="flex items-center gap-1.5"><IconSettings class="size-3.5" />설정</span>
    <span class="flex items-center gap-2 text-ink-500">
      {#if !open}<span class="font-mono">◎{engine.dots} ⇄{engine.swaps} · {engine.stage}단계</span>{/if}
      <IconChevron class="size-3.5 transition-transform {open ? '' : 'rotate-180'}" />
    </span>
  </button>

  {#if open}
    <!-- 펼친 설정은 위로 떠올라 판을 덮는다. 판 크기가 줄지 않게 -->
    <div class="sheet grid gap-2.5 p-2.5" transition:slide={{ duration: 180 }}>
      <div class="grid grid-cols-4 gap-1.5">
        {#each steppers as s (s.label)}
          <div class="tile">
            <span class="flex items-center justify-center gap-0.5 text-[10px] text-ink-400">
              {#if s.icon}<s.icon class="size-3 {s.cls}" />{/if}{s.label}
            </span>
            <span class="font-mono text-sm text-ink-100">{s.get()}</span>
            <span class="flex gap-1">
              <button class="step" aria-label="{s.label} 줄이기" onclick={() => s.set(s.get() - 1)}>−</button>
              <button class="step" aria-label="{s.label} 늘리기" onclick={() => s.set(s.get() + 1)}>+</button>
            </span>
          </div>
        {/each}
      </div>

      <label class="grid gap-1 text-[10px] text-ink-400">
        <span class="flex justify-between"><span>안전</span><span class="text-ink-200">성향</span><span>고득점</span></span>
        <input type="range" min="0" max="1" step="0.05" value={engine.style} onchange={(e) => engine.setStyle(+(e.currentTarget as HTMLInputElement).value)} class="range" />
      </label>

      <label class="grid gap-1 text-[10px] text-ink-400">
        <span class="flex justify-between"><span>계산 시간</span><span class="font-mono text-ink-200">{(engine.thinkMs / 1000).toFixed(1)}초</span></span>
        <input type="range" min="300" max="3000" step="100" bind:value={engine.thinkMs} class="range" />
      </label>

      <button class="again" onclick={() => engine.resolve()}><IconRefresh class="size-3.5" />지금 판으로 다시 계산</button>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; border-radius: 0.8rem; background: rgb(var(--fg) / 0.04); border: 1px solid rgb(var(--fg) / 0.06); }
  .sheet {
    position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 20;
    border-radius: 0.9rem; background: var(--color-ink-850); border: 1px solid rgb(var(--fg) / 0.1);
    box-shadow: 0 -12px 30px -10px rgb(0 0 0 / 0.5);
  }
  .head { display: flex; width: 100%; align-items: center; justify-content: space-between; padding: 0.45rem 0.7rem; font-size: 0.72rem; color: var(--color-ink-300); }
  .tile { display: grid; justify-items: center; gap: 0.2rem; padding: 0.35rem 0.2rem; border-radius: 0.6rem; background: rgb(var(--fg) / 0.04); }
  .step {
    width: 1.35rem; height: 1.35rem; border-radius: 0.4rem; font-size: 0.8rem; line-height: 1;
    color: var(--color-ink-200); background: rgb(var(--fg) / 0.07);
  }
  .step:hover { background: rgb(var(--fg) / 0.14); }
  .range { appearance: none; height: 5px; border-radius: 999px; background: linear-gradient(90deg, var(--color-s1), var(--color-s2), var(--color-s3)); }
  .range::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border-radius: 50%; background: white; box-shadow: 0 1px 4px rgb(0 0 0 / 0.5); }
  .again {
    display: flex; align-items: center; justify-content: center; gap: 0.35rem; height: 1.9rem; border-radius: 0.6rem;
    font-size: 0.72rem; color: var(--color-ink-200); background: rgb(var(--fg) / 0.06);
  }
  .again:hover { background: rgb(var(--fg) / 0.1); }
</style>
