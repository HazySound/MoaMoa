<script lang="ts">
  import { scale, fade } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { COLS, ROWS, type Board, type Icon } from '../core/board'
  import { anchorCell, type Plan } from '../core/solver'
  import IconSwap from '~icons/lucide/arrow-left-right'
  import IconDot from '~icons/lucide/circle-dot'
  import IconPointer from '~icons/lucide/mouse-pointer-2'

  let { board, icons, plan, focus, stepIdx, dot = null }: {
    board: Board
    icons: Icon[]
    plan: Plan | null
    /** 판에 크게 보여 줄 단계 */
    focus: number
    /** 이미 놓은 단계 수 */
    stepIdx: number
    /** 점 찍기를 먼저 쓸 칸 */
    dot?: { r: number; c: number } | null
  } = $props()

  const STEP_COLORS = ['var(--color-s1)', 'var(--color-s2)', 'var(--color-s3)']

  // 보여 줄 단계 직전의 판. 앞 단계에서 지워진 줄이 반영돼 있어야 겹쳐 보이지 않는다
  const base = $derived(plan && focus > stepIdx ? plan.steps[focus - 1].boardAfter : board)
  const baseIcons = $derived(plan && focus > stepIdx ? plan.steps[focus - 1].iconsAfter : icons)
  const step = $derived(plan?.steps[focus] ?? null)

  const ghost = $derived.by(() => {
    const m = new Map<number, number>()
    if (!step) return m
    for (let i = 0; i < step.shape.h; i++)
      for (let j = 0; j < COLS; j++) if ((step.shape.rows[i] >> j) & 1) m.set((step.r + i) * COLS + step.c + j, focus)
    return m
  })
  const clearing = $derived(new Set(step?.cleared ?? []))
  const anchor = $derived(step ? anchorCell(step.shape, step.r, step.c) : null)

  /** 뒤 단계들은 테두리만 흐리게 */
  const later = $derived.by(() => {
    const m = new Map<number, number>()
    if (!plan) return m
    for (let k = focus + 1; k < plan.steps.length; k++) {
      const s = plan.steps[k]
      for (let i = 0; i < s.shape.h; i++)
        for (let j = 0; j < COLS; j++)
          if ((s.shape.rows[i] >> j) & 1) {
            const idx = (s.r + i) * COLS + s.c + j
            if (!((base[s.r + i] >> (s.c + j)) & 1) && !ghost.has(idx)) m.set(idx, k)
          }
    }
    return m
  })

  const iconAt = (r: number, c: number) => baseIcons.find((ic) => ic.r === r && ic.c === c)
  const cells = Array.from({ length: ROWS * COLS }, (_, i) => i)
</script>

<div class="board" style="--cols:{COLS};--rows:{ROWS}">
  {#each cells as i (i)}
    {@const r = Math.floor(i / COLS)}
    {@const c = i % COLS}
    {@const filled = ((base[r] >> c) & 1) === 1}
    {@const g = ghost.get(i)}
    {@const l = later.get(i)}
    {@const ic = iconAt(r, c)}
    <div class="cell" class:filled class:clearing={clearing.has(r)}>
      {#if ic && !filled}
        <span class="icon" class:dot={ic.kind === 'dot'}>
          {#if ic.kind === 'dot'}<IconDot />{:else}<IconSwap />{/if}
        </span>
      {/if}
      {#if g !== undefined}
        {#key `${focus}:${step?.r}:${step?.c}:${step?.shape.key}`}
          <div
            class="ghost"
            style="--c:{STEP_COLORS[g]}"
            in:scale={{ start: 0.4, duration: 380, delay: (r - (step?.r ?? 0)) * 35 + (c - (step?.c ?? 0)) * 20, easing: cubicOut }}
          ></div>
        {/key}
      {:else if l !== undefined}
        <div class="later" style="--c:{STEP_COLORS[l]}" in:fade={{ duration: 200 }}>
          <span>{l + 1}</span>
        </div>
      {/if}
      {#if dot && dot.r === r && dot.c === c}
        <span class="rescue" in:scale={{ start: 0.3, duration: 400, easing: cubicOut }}><IconDot /></span>
      {/if}
      {#if anchor && anchor[0] === r && anchor[1] === c}
        <span class="pointer" style="--c:{STEP_COLORS[focus]}"><IconPointer /></span>
      {/if}
    </div>
  {/each}
</div>

<style>
  .board {
    display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    grid-template-rows: repeat(var(--rows), 1fr);
    gap: 3px;
    aspect-ratio: 10 / 16;
    width: 100%;
    padding: 10px;
    border-radius: 18px;
    background:
      linear-gradient(180deg, rgb(45 212 191 / 0.06), rgb(56 189 248 / 0.03)),
      var(--color-ink-900);
    border: 1px solid rgb(255 255 255 / 0.06);
    box-shadow: inset 0 2px 20px rgb(0 0 0 / 0.5);
  }
  .cell {
    position: relative;
    border-radius: 6px;
    background: rgb(255 255 255 / 0.03);
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.025);
    transition: background-color 300ms var(--ease-out-expo);
  }
  .cell.filled {
    background: linear-gradient(160deg, #4a5d77, #2e3d52);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.12), inset 0 -2px 0 rgb(0 0 0 / 0.25);
  }
  .cell.clearing::after {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: 6px;
    background: linear-gradient(90deg, transparent, rgb(255 255 255 / 0.28), transparent);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
    pointer-events: none;
  }
  .ghost {
    position: absolute;
    inset: 0;
    border-radius: 6px;
    background: color-mix(in oklab, var(--c) 82%, white 0%);
    box-shadow:
      0 0 0 1px color-mix(in oklab, var(--c) 60%, white 40%) inset,
      0 0 18px -2px var(--c);
    animation: breathe 2.2s ease-in-out infinite;
  }
  .later {
    position: absolute;
    inset: 1px;
    border-radius: 5px;
    border: 1.5px dashed color-mix(in oklab, var(--c) 70%, transparent);
    display: grid;
    place-items: center;
    font: 600 10px/1 var(--font-mono);
    color: color-mix(in oklab, var(--c) 80%, transparent);
  }
  .icon {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #c084fc;
    font-size: 70%;
    filter: drop-shadow(0 0 6px rgb(192 132 252 / 0.6));
  }
  .icon.dot { color: #38bdf8; filter: drop-shadow(0 0 6px rgb(56 189 248 / 0.6)); }
  .pointer {
    position: absolute;
    left: 45%;
    top: 40%;
    z-index: 2;
    color: white;
    font-size: 15px;
    filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.8)) drop-shadow(0 0 6px var(--c));
    animation: tap 1.4s var(--ease-out-expo) infinite;
  }
  .rescue {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    place-items: center;
    border-radius: 6px;
    color: #e0f2fe;
    background: rgb(56 189 248 / 0.85);
    box-shadow: 0 0 0 2px #e0f2fe inset, 0 0 18px #38bdf8;
    animation: breathe 1.2s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { filter: brightness(1); }
    50% { filter: brightness(1.18); }
  }
  @keyframes shimmer { to { background-position: -200% 0; } }
  @keyframes tap {
    0%, 100% { transform: translate(0, 0); }
    50% { transform: translate(-2px, -2px); }
  }
</style>
