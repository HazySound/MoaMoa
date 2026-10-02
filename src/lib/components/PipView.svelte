<script lang="ts">
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { engine } from '../engine.svelte'
  import Board from './Board.svelte'
  import MiniShape from './MiniShape.svelte'
  import Thinking from './Thinking.svelte'
  import LiveBoard from './LiveBoard.svelte'
  import IconRotate from '~icons/lucide/rotate-cw'
  import IconFlip from '~icons/lucide/flip-horizontal-2'
  import IconCheck from '~icons/lucide/check'
  import IconAlert from '~icons/lucide/triangle-alert'
  import IconSwap from '~icons/lucide/arrow-left-right'
  import IconDot from '~icons/lucide/circle-dot'

  /*
   * 게임 위에 띄워 두는 작은 창. 판과 '지금 할 일' 하나만 크게 보여 준다.
   * 상태는 원래 탭의 engine을 그대로 쓴다.
   */

  const STEP_COLORS = ['var(--color-s1)', 'var(--color-s2)', 'var(--color-s3)']
  const PIECE_COLORS: Record<string, string> = { pink: '#f472b6', green: '#84cc16', blue: '#38bdf8', yellow: '#facc15' }
  const STATUS: Record<string, string> = {
    idle: '대기', searching: '판 찾는 중', live: '인식 중', busy: '미리보기 중', obscured: '가려짐', image: '스크린샷',
  }

  let picked = $state<number | null>(null)
  /** 실제 게임 화면 위에 표시할지, 단순화한 판으로 볼지 */
  let real = $state(readReal())
  function readReal() { try { return localStorage.getItem('moamoa.pip.real') !== '0' } catch { return true } }
  function toggleReal() {
    real = !real
    try { localStorage.setItem('moamoa.pip.real', real ? '1' : '0') } catch { /* 이번 창에서만 */ }
  }
  const plan = $derived(engine.plan)
  const current = $derived(Math.min(engine.stepIdx, Math.max(0, (plan?.steps.length ?? 1) - 1)))
  const focus = $derived(picked ?? current)
  const step = $derived(plan?.steps[focus] ?? null)
  const turns = $derived(step ? engine.turnsFor(step) : null)
  const done = $derived(plan ? engine.stepIdx >= plan.steps.length : false)

  // 단계가 넘어가면 직접 고른 단계 보기를 풀고 지금 단계로 돌아온다
  $effect(() => { void engine.stepIdx; void engine.planIdx; picked = null })

  const pieceName = (i: number) => engine.hand[i]?.piece?.name ?? '?'
  const pieceColor = (i: number) => PIECE_COLORS[engine.hand[i]?.piece?.color ?? ''] ?? 'var(--color-ink-300)'
</script>

<div class="flex h-dvh flex-col gap-2.5 bg-ink-950 p-2.5 text-ink-100 select-none">
  <!-- 윗줄: 상태 · 단계 · 점수 -->
  <div class="flex items-center justify-between text-xs">
    <span class="flex items-center gap-1.5">
      <span class="status" data-s={engine.status}><i></i>{STATUS[engine.status]}</span>
      <button class="view" onclick={toggleReal} title="실제 게임 화면 / 단순화한 판">{real ? '실제' : '도식'}</button>
    </span>
    {#if plan}
      <div class="flex items-center gap-1.5">
        {#each plan.steps as _, k (k)}
          <button
            class="dot"
            class:active={focus === k}
            class:done={k < engine.stepIdx}
            style="--c:{STEP_COLORS[k]}"
            aria-label="{k + 1}단계 보기"
            onclick={() => (picked = k)}
          >{#if k < engine.stepIdx}<IconCheck class="size-3" />{:else}{k + 1}{/if}</button>
        {/each}
        <span class="ml-1 font-mono text-ink-300">+{plan.gained}</span>
      </div>
    {/if}
  </div>

  <!-- 판 -->
  <div class="fit-box min-h-0 flex-1">
    <div class="fit relative rounded-[14px]">
      {#if real && engine.lastFrame && engine.grid}
        <LiveBoard frame={engine.lastFrame} grid={engine.grid} {plan} {focus} stepIdx={engine.stepIdx} dot={engine.rescue?.kind === 'dot' ? engine.rescue : null} />
      {:else}
        <Board board={engine.board} icons={engine.icons} {plan} {focus} stepIdx={engine.stepIdx} dot={engine.rescue?.kind === 'dot' ? engine.rescue : null} />
      {/if}
      {#if engine.solving}<Thinking progress={engine.progress} reason={engine.solveReason} compact />{/if}
    </div>
  </div>

  <!-- 지금 할 일 -->
  <!-- 능력: 게임 오른쪽 '보유 능력' 칸과 같은 정보 -->
  <div class="abil">
    <span class="flex items-center gap-1" title="바꿔 뽑기"><IconSwap class="size-3.5 text-violet-400" /><b>{engine.swaps}</b></span>
    <span class="flex items-center gap-1" title="점 찍기"><IconDot class="size-3.5 text-sky-400" /><b>{engine.dots}</b></span>
    <span class="text-ink-400" class:full={engine.held >= 7}>보유 {engine.held}/7</span>
    <span class="ml-auto text-ink-400">다음 능력 <b class="text-ink-100">{engine.nextAbility ?? '?'}</b>번</span>
  </div>

  {#if plan?.incomplete}
    <div class="flex items-center gap-2 rounded-xl border border-s3/30 bg-s3/10 px-3 py-2 text-xs text-s3">
      <IconAlert class="size-4 shrink-0" />
      {#if engine.rescue?.kind === 'dot'}
        점 찍기 먼저 → 표시한 칸 (↓{engine.rescue.r + 1} →{engine.rescue.c + 1})
      {:else if engine.rescue?.kind === 'swap'}
        바꿔 뽑기 → {engine.rescue.slot + 1}번 카드 ‘{pieceName(engine.rescue.slot)}’
      {:else}
        다 못 놓아요 · 놓을 수 있는 만큼만
      {/if}
    </div>
  {:else if engine.rescue?.proactive}
    <div class="flex items-center gap-2 rounded-xl border border-violet-400/30 bg-violet-400/10 px-3 py-2 text-xs text-ink-100">
      {#if engine.rescue.kind === 'dot'}
        <IconDot class="size-4 shrink-0 text-sky-400" />먼저 점 찍기 → 표시한 칸 (↓{engine.rescue.r + 1} →{engine.rescue.c + 1})
      {:else}
        <IconSwap class="size-4 shrink-0 text-violet-400" />먼저 바꿔 뽑기 → {engine.rescue.slot + 1}번 ‘{pieceName(engine.rescue.slot)}’
      {/if}
    </div>
  {/if}

  {#if engine.solving}
    <div class="rounded-xl bg-fg/[0.04] px-3 py-3 text-center text-xs text-ink-300">새 세트 계산 중 · 잠시만요</div>
  {:else if step && !done}
    {#key `${engine.planIdx}:${focus}`}
      <div class="now" style="--c:{STEP_COLORS[focus]}" in:fly={{ y: 10, duration: 350, easing: cubicOut }}>
        <span class="badge">{focus + 1}</span>
        <div class="grid size-12 shrink-0 place-items-center rounded-lg bg-ink-900">
          <MiniShape shape={step.shape} color={pieceColor(step.slot)} cell={Math.min(9, Math.floor(40 / Math.max(step.shape.w, step.shape.h)) - 2)} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold">{step.slot + 1}번 카드 ‘{pieceName(step.slot)}’</p>
          <div class="mt-1 flex flex-wrap gap-1 text-[11px]">
            {#if focus < engine.stepIdx}
              <span class="chip">놓음</span>
            {:else if turns?.ok}
              <span class="chip ok"><IconCheck class="size-3" />방향 맞음</span>
            {:else if turns}
              {#if turns.flip}<span class="chip"><IconFlip class="size-3" />반전</span>{/if}
              {#if turns.rot}<span class="chip"><IconRotate class="size-3" />회전 {turns.rot}</span>{/if}
            {/if}
            {#if step.cleared.length}<span class="chip" style="color:var(--c)">{step.cleared.length}줄</span>{/if}
          </div>
        </div>
      </div>
    {/key}
  {:else if done}
    <div class="rounded-xl bg-fg/[0.04] px-3 py-3 text-center text-xs text-ink-300">세트 완료 · 새 조각을 기다리는 중</div>
  {:else}
    <div class="rounded-xl bg-fg/[0.04] px-3 py-3 text-center text-xs text-ink-400">
      {engine.live ? '보유 조각을 읽으면 추천이 떠요' : '원래 창에서 화면 공유를 시작해 주세요'}
    </div>
  {/if}
</div>

<style>
  /* 창 크기에 맞춰 10:16 판이 잘리지 않게 가로·세로 중 작은 쪽에 맞춘다 */
  .fit-box { container-type: size; display: grid; place-items: center; }
  .fit { width: min(100cqw, calc(100cqh * 0.625)); }
  .fit :global(.board) { padding: 6px; gap: 2px; border-radius: 14px; }

  .status {
    display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.25rem 0.6rem; border-radius: 999px;
    color: var(--color-ink-200); background: rgb(var(--fg) / 0.05);
  }
  .status i { width: 6px; height: 6px; border-radius: 50%; background: var(--color-ink-400); }
  .status[data-s='live'] i { background: var(--color-s1); }
  .status[data-s='busy'] i, .status[data-s='searching'] i { background: var(--color-s2); }
  .status[data-s='obscured'] i { background: var(--color-s3); }

  .abil {
    display: flex; align-items: center; gap: 0.8rem; padding: 0.45rem 0.7rem; border-radius: 0.8rem;
    font-size: 0.72rem; background: rgb(var(--fg) / 0.04); border: 1px solid rgb(var(--fg) / 0.06);
  }
  .abil b { font-family: var(--font-mono); font-weight: 600; }
  .abil .full { color: var(--color-s3); }
  .view {
    padding: 0.2rem 0.5rem; border-radius: 999px; font-size: 0.68rem; color: var(--color-ink-300);
    background: rgb(var(--fg) / 0.05); border: 1px solid rgb(var(--fg) / 0.08);
  }
  .dot {
    display: grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 999px;
    font: 600 0.7rem/1 var(--font-mono); color: var(--c);
    border: 1.5px solid color-mix(in oklab, var(--c) 60%, transparent);
    transition: all 200ms var(--ease-out-expo);
  }
  .dot.active { color: var(--color-ink-950); background: var(--c); border-color: var(--c); }
  .dot.done { opacity: 0.45; }

  .now {
    display: flex; align-items: center; gap: 0.65rem; padding: 0.6rem; border-radius: 0.9rem;
    background: color-mix(in oklab, var(--c) 9%, var(--color-ink-900));
    border: 1px solid color-mix(in oklab, var(--c) 40%, transparent);
    box-shadow: 0 10px 30px -18px var(--c);
  }
  .badge {
    display: grid; place-items: center; width: 1.7rem; height: 1.7rem; flex-shrink: 0; border-radius: 999px;
    font: 700 0.8rem/1 var(--font-mono); color: var(--color-ink-950); background: var(--c);
  }
  .chip {
    display: inline-flex; align-items: center; gap: 0.2rem; padding: 0.15rem 0.45rem; border-radius: 999px;
    color: var(--color-ink-100); background: rgb(var(--fg) / 0.08);
  }
  .chip.ok { color: var(--color-s1); background: rgb(45 212 191 / 0.14); }
</style>
