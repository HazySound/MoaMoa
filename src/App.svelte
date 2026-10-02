<script lang="ts">
  import { fly, fade, slide } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { Tween } from 'svelte/motion'
  import { engine } from './lib/engine.svelte'
  import { pip } from './lib/pip.svelte'
  import { theme } from './lib/theme.svelte'
  import Board from './lib/components/Board.svelte'
  import MiniShape from './lib/components/MiniShape.svelte'
  import SourcePreview from './lib/components/SourcePreview.svelte'
  import Thinking from './lib/components/Thinking.svelte'
  import StatsPanel from './lib/components/StatsPanel.svelte'
  import { PIECES, identify } from './lib/core/pieces'
  import IconScreen from '~icons/lucide/monitor-up'
  import IconStop from '~icons/lucide/square'
  import IconImage from '~icons/lucide/image-plus'
  import IconRotate from '~icons/lucide/rotate-cw'
  import IconFlip from '~icons/lucide/flip-horizontal-2'
  import IconCheck from '~icons/lucide/check'
  import IconScan from '~icons/lucide/scan-eye'
  import IconShield from '~icons/lucide/shield-check'
  import IconFlame from '~icons/lucide/flame'
  import IconSwap from '~icons/lucide/arrow-left-right'
  import IconDot from '~icons/lucide/circle-dot'
  import IconRefresh from '~icons/lucide/refresh-cw'
  import IconAlert from '~icons/lucide/triangle-alert'
  import IconChevron from '~icons/lucide/chevron-down'
  import IconLock from '~icons/lucide/lock'
  import IconPip from '~icons/lucide/picture-in-picture-2'
  import IconSun from '~icons/lucide/sun'
  import IconMoon from '~icons/lucide/moon'

  const STEP_COLORS = ['var(--color-s1)', 'var(--color-s2)', 'var(--color-s3)']
  const PIECE_COLORS: Record<string, string> = { pink: '#f472b6', green: '#84cc16', blue: '#38bdf8', yellow: '#facc15' }

  let focus = $state(0)
  let showSource = $state(false)
  let dragging = $state(false)
  let fileInput: HTMLInputElement | undefined = $state()

  const plan = $derived(engine.plan)
  const hasData = $derived(engine.updatedAt > 0)

  // 단계가 넘어가면 판도 그 단계를 보여 준다
  $effect(() => { focus = Math.min(engine.stepIdx, Math.max(0, (plan?.steps.length ?? 1) - 1)) })

  const gainedTween = new Tween(0, { duration: 600, easing: cubicOut })
  const riskTween = new Tween(0, { duration: 600, easing: cubicOut })
  $effect(() => {
    gainedTween.target = plan?.gained ?? 0
    riskTween.target = plan?.risk ?? 0
  })

  const riskLabel = $derived(
    !plan ? '' : plan.incomplete ? '배치 불가' : plan.risk < 0.08 ? '안전' : plan.risk < 0.3 ? '주의' : '위험',
  )
  const riskColor = $derived(
    !plan ? 'var(--color-ink-400)' : plan.incomplete || plan.risk >= 0.3 ? 'var(--color-s3)' : plan.risk >= 0.08 ? 'var(--color-s2)' : 'var(--color-s1)',
  )

  const unplaced = $derived.by(() => {
    if (!plan?.incomplete) return []
    const placed = new Set(plan.steps.map((s) => s.slot))
    return engine.hand.map((h, i) => ({ h, i })).filter(({ h, i }) => h.state === 'piece' && !placed.has(i))
  })

  const statusText: Record<string, string> = {
    idle: '대기 중',
    searching: '게임판 찾는 중',
    live: '실시간 인식 중',
    busy: '배치 미리보기 중',
    obscured: '판이 가려짐',
    image: '스크린샷 분석',
  }

  function onPaste(e: ClipboardEvent) {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
    if (file) engine.loadImage(file)
  }
  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'))
    if (file) engine.loadImage(file)
  }
  function onFile(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0]
    if (f) engine.loadImage(f)
  }

  const pieceName = (i: number) => engine.hand[i]?.piece?.name ?? '?'
  const pieceColor = (i: number) => PIECE_COLORS[engine.hand[i]?.piece?.color ?? ''] ?? 'var(--color-ink-300)'
</script>

<svelte:window
  onpaste={onPaste}
  ondragover={(e) => { e.preventDefault(); dragging = true }}
  ondragleave={(e) => { if (!e.relatedTarget) dragging = false }}
  ondrop={onDrop}
/>

<input bind:this={fileInput} type="file" accept="image/*" class="hidden" onchange={onFile} />

<div class="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 pb-8 sm:px-6">
  <!-- 머리 -->
  <header class="flex flex-wrap items-center justify-between gap-3 py-5">
    <div class="flex items-center gap-3">
      <div class="logo" aria-hidden="true">
        <span style="background:var(--color-s1)"></span><span style="background:var(--color-s1)"></span>
        <span style="background:var(--color-s1)"></span><span></span>
        <span></span><span style="background:var(--color-s2)"></span>
        <span style="background:var(--color-s2)"></span><span style="background:var(--color-s2)"></span>
      </div>
      <div>
        <h1 class="text-lg font-bold tracking-tight">모아모아 도우미</h1>
        <p class="text-xs text-ink-400">메이플스토리 한글 모아모아 · 배치 추천</p>
      </div>
    </div>

    <div class="flex items-center gap-2">
      {#if engine.status !== 'idle'}
        <span class="status" data-s={engine.status} in:fade>
          <i></i>{statusText[engine.status]}
        </span>
      {/if}
      <button
        class="btn ghost icon"
        onclick={() => theme.toggle()}
        aria-label={theme.current === 'light' ? '다크 모드로' : '라이트 모드로'}
        title={theme.current === 'light' ? '다크 모드로' : '라이트 모드로'}
      >
        {#key theme.current}
          <span class="grid place-items-center" in:fly={{ y: 6, duration: 250 }}>
            {#if theme.current === 'light'}<IconMoon class="size-4" />{:else}<IconSun class="size-4" />{/if}
          </span>
        {/key}
      </button>
      {#if pip.supported}
        <button class="btn ghost" class:on={pip.open} onclick={() => pip.toggle()} title="게임 위에 늘 떠 있는 작은 창">
          <IconPip class="size-4" />{pip.open ? '작은 창 닫기' : '작은 창'}
        </button>
      {/if}
      {#if engine.live}
        <button class="btn ghost" onclick={() => engine.stopCapture()}><IconStop class="size-4" />공유 중지</button>
      {:else}
        <button class="btn ghost hidden sm:inline-flex" onclick={() => fileInput?.click()}><IconImage class="size-4" />스크린샷</button>
        <button class="btn primary" onclick={() => engine.startCapture()}><IconScreen class="size-4" />화면 공유</button>
      {/if}
    </div>
  </header>

  {#if engine.error}
    <div class="mb-4 flex items-center gap-2 rounded-xl border border-s3/30 bg-s3/10 px-4 py-3 text-sm text-s3" transition:slide>
      <IconAlert class="size-4 shrink-0" />{engine.error}
    </div>
  {/if}

  {#if !hasData}
    <!-- 처음 화면 -->
    <section class="grid flex-1 items-center gap-10 py-6 lg:grid-cols-[1.1fr_1fr]" in:fade>
      <div>
        <p class="mb-3 inline-flex items-center gap-1.5 rounded-full border border-s1/25 bg-s1/10 px-3 py-1 text-xs font-medium text-s1">
          <IconScan class="size-3.5" />화면을 읽어서 자동으로
        </p>
        <h2 class="text-4xl leading-[1.15] font-extrabold tracking-tight text-balance sm:text-5xl">
          다음 조각,<br /><span class="grad">어디에 둘지</span> 알려 드려요
        </h2>
        <p class="mt-5 max-w-md text-[15px] leading-relaxed text-ink-300">
          게임 창을 공유하면 판과 보유 조각을 읽어서 세 조각을 놓을 순서·방향·자리를 추천해요.
          이번 세트 점수뿐 아니라 다음 세트에 놓을 자리가 남는지까지 따져요.
        </p>
        <div class="mt-8 flex flex-wrap gap-3">
          <button class="btn primary lg" onclick={() => engine.startCapture()}><IconScreen class="size-5" />화면 공유 시작</button>
          <button class="btn ghost lg" onclick={() => fileInput?.click()}><IconImage class="size-5" />스크린샷으로 해 보기</button>
        </div>
        <p class="mt-4 flex items-center gap-1.5 text-xs text-ink-400">
          <IconLock class="size-3.5" />화면은 이 브라우저 안에서만 읽고 어디로도 보내지 않아요 · 이미지를 붙여넣거나(Ctrl+V) 끌어다 놓아도 돼요
        </p>
      </div>

      <ol class="panel grid gap-1 p-3">
        {#each [
          ['게임에서 한글 모아모아를 열어요', '창 전체가 가려지지 않게 두세요.'],
          ['화면 공유에서 메이플스토리 창을 골라요', '‘창’ 탭에서 MapleStory를 선택하면 다른 창에 가려져도 읽을 수 있어요.'],
          ['‘작은 창’을 띄워 게임 옆에 두세요', '늘 위에 떠 있는 작은 창에 판과 지금 할 일이 나와요. 게임을 보면서 바로 놓을 수 있어요.'],
          ['추천대로 놓아요', '번호 순서대로, 표시된 방향으로 돌린 뒤 커서 표시 칸에 클릭하면 돼요. 놓을 때마다 알아서 다음 단계로 넘어가요.'],
        ] as [t, d], i}
          <li class="flex gap-4 rounded-2xl p-4 transition-colors hover:bg-fg/[0.03]" in:fly={{ y: 12, delay: 120 + i * 90, duration: 500, easing: cubicOut }}>
            <span class="grid size-8 shrink-0 place-items-center rounded-full font-mono text-sm font-semibold text-ink-950" style="background:{STEP_COLORS[i % 3]}">{i + 1}</span>
            <div>
              <p class="font-semibold">{t}</p>
              <p class="mt-1 text-sm leading-relaxed text-ink-400">{d}</p>
            </div>
          </li>
        {/each}
      </ol>
    </section>
  {:else}
    <!-- 추천 화면 -->
    <main class="grid gap-5 lg:grid-cols-[minmax(0,420px)_1fr]" in:fade>
      <section class="flex flex-col gap-3">
        <div class="relative">
          <Board board={engine.board} icons={engine.icons} {plan} {focus} stepIdx={engine.stepIdx} dot={engine.rescue?.kind === 'dot' ? engine.rescue : null} />
          {#if engine.solving}
            <div class="absolute inset-0 rounded-[18px]"><Thinking progress={engine.progress} /></div>
          {/if}
        </div>
        {#if plan}
          <div class="flex gap-2">
            {#each plan.steps as s, k (k)}
              <button
                class="step-tab"
                class:active={focus === k}
                class:done={k < engine.stepIdx}
                style="--c:{STEP_COLORS[k]}"
                onclick={() => (focus = k)}
              >
                <span class="num">{#if k < engine.stepIdx}<IconCheck class="size-3.5" />{:else}{k + 1}{/if}</span>
                {pieceName(s.slot)}
              </button>
            {/each}
          </div>
        {/if}
      </section>

      <section class="flex min-w-0 flex-col gap-4">
        <!-- 요약 -->
        <div class="panel grid grid-cols-3 divide-x divide-fg/5 p-1">
          <div class="p-4">
            <p class="text-xs text-ink-400">이번 세트 점수</p>
            <p class="mt-1 font-mono text-2xl font-semibold text-ink-100">+{Math.round(gainedTween.current).toLocaleString()}</p>
          </div>
          <div class="p-4">
            <p class="text-xs text-ink-400">지우는 줄</p>
            <p class="mt-1 font-mono text-2xl font-semibold">{plan?.steps.reduce((a, s) => a + s.cleared.length, 0) ?? 0}<span class="ml-1 text-sm text-ink-400">줄</span></p>
          </div>
          <div class="p-4">
            <p class="text-xs text-ink-400">다음 세트 위험도</p>
            <p class="mt-1 text-2xl font-bold" style="color:{riskColor}">{riskLabel}</p>
            <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-fg/5">
              <div class="h-full rounded-full" style="width:{Math.max(4, riskTween.current * 100)}%;background:{riskColor}"></div>
            </div>
          </div>
        </div>

        {#if plan?.incomplete}
          <div class="panel flex gap-3 border-s3/30! p-4 text-sm" transition:slide>
            <IconAlert class="mt-0.5 size-5 shrink-0 text-s3" />
            <div class="leading-relaxed">
              <p class="font-semibold text-s3">세 조각을 다 놓을 수 없어요</p>
              <p class="mt-1 text-ink-300">
                {#if engine.rescue?.kind === 'dot'}
                  먼저 <b class="text-ink-100">점 찍기</b>를 판에 표시한 칸(↓{engine.rescue.r + 1}행 →{engine.rescue.c + 1}열)에 쓰세요. 그러면 세 조각을 다 놓을 수 있어요.
                {:else if engine.rescue?.kind === 'swap'}
                  <b class="text-ink-100">바꿔 뽑기</b>로 {engine.rescue.slot + 1}번 카드 ‘{pieceName(engine.rescue.slot)}’를 바꾸세요. 새 조각이 들어오면 다시 계산해요.
                {:else if engine.swaps > 0}
                  <b class="text-ink-100">바꿔 뽑기</b>로 {unplaced.map(({ i }) => `‘${pieceName(i)}’`).join(', ')} 조각을 바꿔 보세요.
                {:else if engine.dots > 0}
                  <b class="text-ink-100">점 찍기</b>로 거의 찬 줄을 먼저 지워 자리를 만들어 보세요.
                {:else}
                  남은 능력이 없어요. 놓을 수 있는 만큼 놓는 계획을 보여 드려요.
                {/if}
              </p>
            </div>
          </div>
        {:else if plan && plan.risk >= 0.3 && engine.swaps > 0}
          <div class="panel flex gap-3 p-4 text-sm" transition:slide>
            <IconSwap class="mt-0.5 size-5 shrink-0 text-violet-300" />
            <p class="leading-relaxed text-ink-300">판이 빡빡해요. 다음 세트에서 막히면 <b class="text-ink-100">바꿔 뽑기</b>를 아껴 두었다 쓰세요.</p>
          </div>
        {/if}

        <!-- 단계별 안내 -->
        {#if plan}
          <ol class="flex flex-col gap-2.5">
            {#each plan.steps as s, k (`${engine.planIdx}:${k}`)}
              {@const turns = engine.turnsFor(s)}
              {@const done = k < engine.stepIdx}
              {@const now = k === engine.stepIdx}
              <li
                class="step panel"
                class:now
                class:done
                style="--c:{STEP_COLORS[k]}"
                in:fly={{ x: 16, delay: k * 70, duration: 450, easing: cubicOut }}
              >
                <button class="flex w-full items-center gap-4 p-4 text-left" onclick={() => (focus = k)}>
                  <span class="badge">{#if done}<IconCheck class="size-4" />{:else}{k + 1}{/if}</span>
                  <div class="grid size-14 shrink-0 place-items-center rounded-xl bg-ink-900/80">
                    <MiniShape shape={s.shape} color={pieceColor(s.slot)} cell={Math.min(10, Math.floor(46 / Math.max(s.shape.w, s.shape.h)) - 2)} />
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="flex flex-wrap items-baseline gap-x-2 font-semibold">
                      <span>{s.slot + 1}번 카드 ‘{pieceName(s.slot)}’</span>
                      <span class="text-xs font-normal text-ink-400">{s.shape.cells}칸</span>
                    </p>
                    <div class="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                      {#if done}
                        <span class="chip">놓음</span>
                      {:else if turns}
                        {#if turns.ok}
                          <span class="chip ok"><IconCheck class="size-3" />방향 맞음</span>
                        {:else}
                          {#if turns.flip}<span class="chip"><IconFlip class="size-3" />반전</span>{/if}
                          {#if turns.rot}<span class="chip"><IconRotate class="size-3" />회전 {turns.rot}번</span>{/if}
                        {/if}
                      {/if}
                      <span class="chip muted">↓{s.r + 1}행 →{s.c + 1}열</span>
                    </div>
                  </div>
                  <div class="text-right">
                    <p class="font-mono text-sm font-semibold" style="color:var(--c)">+{s.gained}</p>
                    {#if s.cleared.length}<p class="text-xs text-ink-300">{s.cleared.length}줄 제거</p>{/if}
                    {#if s.abilities}<p class="text-xs text-violet-300">능력 획득</p>{/if}
                  </div>
                </button>
              </li>
            {/each}
          </ol>

          {#if engine.plans.length > 1 && engine.stepIdx === 0}
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="text-ink-400">다른 수</span>
              {#each engine.plans as p, i (i)}
                <button class="alt" class:active={engine.planIdx === i} onclick={() => { engine.planIdx = i; engine.stepIdx = 0; focus = 0 }}>
                  {i + 1}안 · +{p.gained}{p.risk >= 0.3 ? ' · 위험' : ''}
                </button>
              {/each}
            </div>
          {/if}
        {:else if !engine.solving}
          <div class="panel p-6 text-sm text-ink-400">보유 조각을 읽으면 추천이 나타나요.</div>
        {/if}

        <!-- 읽은 보유 조각 -->
        <div class="panel p-4">
          <p class="mb-3 text-xs font-medium text-ink-400">읽은 보유 조각</p>
          <div class="grid grid-cols-3 gap-2">
            {#each engine.hand as h, i (i)}
              <div class="hand" class:selected={h.selected} class:used={h.state === 'used'}>
                {#if h.state === 'used'}
                  <span class="text-xs text-ink-500">사용 완료</span>
                {:else if h.shape}
                  <MiniShape shape={h.shape} color={pieceColor(i)} cell={7} gap={1.5} />
                  <span class="mt-2 text-xs text-ink-300">{h.piece?.name ?? '모르는 조각'} · {h.shape.cells}칸</span>
                {/if}
              </div>
            {/each}
          </div>
        </div>

        <!-- 설정 -->
        <div class="panel grid gap-5 p-4 sm:grid-cols-2">
          <label class="block">
            <span class="flex items-center justify-between text-xs text-ink-400">
              <span class="flex items-center gap-1"><IconShield class="size-3.5" />안전</span>
              <span class="font-medium text-ink-200">플레이 성향</span>
              <span class="flex items-center gap-1">고득점<IconFlame class="size-3.5" /></span>
            </span>
            <input
              type="range" min="0" max="1" step="0.05" value={engine.style}
              onchange={(e) => engine.setStyle(+(e.currentTarget as HTMLInputElement).value)}
              class="range mt-3 w-full"
            />
          </label>
          <div class="grid grid-cols-3 gap-2 text-xs">
            {#each [
              { label: '바꿔 뽑기', icon: IconSwap, get: () => engine.swaps, set: (v: number) => (engine.swaps = v) },
              { label: '점 찍기', icon: IconDot, get: () => engine.dots, set: (v: number) => (engine.dots = v) },
              { label: '제거한 줄', icon: null, get: () => engine.lines, set: (v: number) => (engine.lines = v) },
            ] as f (f.label)}
              <div class="rounded-xl bg-ink-900/70 p-2 text-center">
                <p class="flex items-center justify-center gap-1 text-ink-400">{#if f.icon}<f.icon class="size-3" />{/if}{f.label}</p>
                <div class="mt-1 flex items-center justify-center gap-1.5">
                  <button class="stepper" aria-label="{f.label} 줄이기" onclick={() => f.set(Math.max(0, f.get() - 1))}>−</button>
                  <span class="w-7 font-mono text-sm text-ink-100">{f.get()}</span>
                  <button class="stepper" aria-label="{f.label} 늘리기" onclick={() => f.set(f.get() + 1)}>+</button>
                </div>
              </div>
            {/each}
          </div>
          <label class="block sm:col-span-2">
            <span class="flex items-center justify-between text-xs text-ink-400">
              <span>계산 시간</span>
              <span class="font-mono text-ink-200">{(engine.thinkMs / 1000).toFixed(engine.thinkMs % 1000 ? 2 : 1)}초</span>
            </span>
            <input
              type="range" min="300" max="3000" step="100" bind:value={engine.thinkMs}
              class="range mt-3 w-full"
            />
            <span class="mt-1.5 block text-[11px] text-ink-500">길게 줄수록 다음 세트를 더 많이 가상으로 놓아 보고 골라요. 새 세트부터 적용돼요.</span>
          </label>
          <p class="text-[11px] leading-relaxed text-ink-500 sm:col-span-2">
            능력과 제거한 줄 수는 판 변화로 자동으로 세요. 중간부터 켰다면 게임 화면에 맞춰 고쳐 주세요.
            지금 {engine.stage}단계 기준으로 다음 조각 확률을 어림해요. 이 단계에서 실제로 본 조각 {engine.seenThisStage}개를 반영했어요(많을수록 정확해져요).
          </p>
        </div>

        <StatsPanel />

        <!-- 인식 화면 -->
        <div class="panel overflow-hidden">
          <button class="flex w-full items-center justify-between p-4 text-sm" onclick={() => (showSource = !showSource)}>
            <span class="flex items-center gap-2 text-ink-300"><IconScan class="size-4" />인식 화면 보기</span>
            <span class="flex items-center gap-3 text-xs text-ink-500">
              {#if engine.solveMs}계산 {engine.solveMs}ms{/if}
              <IconChevron class="size-4 transition-transform {showSource ? 'rotate-180' : ''}" />
            </span>
          </button>
          {#if showSource}
            <div class="px-4 pb-4" transition:slide>
              <SourcePreview frame={engine.lastFrame} grid={engine.grid} />
              <div class="mt-3 flex gap-2">
                <button class="btn ghost sm" onclick={() => engine.resolve()}><IconRefresh class="size-3.5" />다시 계산</button>
              </div>
            </div>
          {/if}
        </div>
      </section>
    </main>
  {/if}

  <footer class="mt-auto flex flex-wrap items-center justify-between gap-2 pt-10 text-[11px] text-ink-500">
    <span>조각 {PIECES.length}종 · 판 10×16 · 비공식 팬 도구</span>
    <span class="font-mono">{__BUILD__}</span>
  </footer>
</div>

{#if dragging}
  <div class="pointer-events-none fixed inset-4 z-50 grid place-items-center rounded-3xl border-2 border-dashed border-s1/60 bg-ink-950/70 text-lg font-semibold text-s1 backdrop-blur" transition:fade={{ duration: 120 }}>
    스크린샷을 놓으면 분석해요
  </div>
{/if}

<style>
  .logo {
    display: grid;
    grid-template-columns: repeat(4, 7px);
    gap: 2px;
    padding: 7px;
    border-radius: 12px;
    background: var(--color-ink-800);
    border: 1px solid rgb(var(--fg) / 0.06);
  }
  .logo span { width: 7px; height: 7px; border-radius: 2px; background: rgb(var(--fg) / 0.06); }
  .grad {
    background: linear-gradient(90deg, var(--color-s1), color-mix(in oklab, var(--color-s1) 50%, var(--color-s2)) 50%, var(--color-s2));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    height: 2.5rem;
    padding: 0 1rem;
    border-radius: 0.8rem;
    font-size: 0.875rem;
    font-weight: 600;
    transition: transform 200ms var(--ease-out-expo), background-color 200ms, box-shadow 200ms;
  }
  .btn:active { transform: scale(0.97); }
  .btn.lg { height: 3rem; padding: 0 1.4rem; font-size: 0.95rem; border-radius: 0.95rem; }
  .btn.sm { height: 2rem; padding: 0 0.75rem; font-size: 0.8rem; }
  .btn.primary {
    color: var(--on-accent);
    background: linear-gradient(180deg, color-mix(in oklab, var(--color-s1) 78%, white), var(--color-s1));
    box-shadow: 0 0 0 1px rgb(255 255 255 / 0.2) inset, 0 8px 24px -8px color-mix(in oklab, var(--color-s1) 60%, transparent);
  }
  .btn.primary:hover { box-shadow: 0 0 0 1px rgb(255 255 255 / 0.3) inset, 0 10px 30px -8px color-mix(in oklab, var(--color-s1) 80%, transparent); }
  .btn.ghost { color: var(--color-ink-200); background: rgb(var(--fg) / 0.05); border: 1px solid rgb(var(--fg) / 0.08); }
  .btn.ghost:hover { background: rgb(var(--fg) / 0.09); }
  .btn.icon { width: 2.5rem; padding: 0; justify-content: center; }
  .btn.ghost.on { color: var(--color-s1); border-color: rgb(45 212 191 / 0.4); background: rgb(45 212 191 / 0.08); }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    height: 2rem;
    padding: 0 0.8rem;
    border-radius: 999px;
    font-size: 0.75rem;
    color: var(--color-ink-200);
    background: rgb(var(--fg) / 0.04);
    border: 1px solid rgb(var(--fg) / 0.07);
  }
  .status i { width: 7px; height: 7px; border-radius: 50%; background: var(--color-ink-400); }
  .status[data-s='live'] i { background: var(--color-s1); box-shadow: 0 0 0 0 rgb(45 212 191 / 0.6); animation: ping 1.8s infinite; }
  .status[data-s='busy'] i, .status[data-s='searching'] i { background: var(--color-s2); }
  .status[data-s='obscured'] i { background: var(--color-s3); }
  @keyframes ping { 70% { box-shadow: 0 0 0 7px rgb(45 212 191 / 0); } 100% { box-shadow: 0 0 0 0 rgb(45 212 191 / 0); } }


  .step-tab {
    flex: 1;
    display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;
    height: 2.4rem; border-radius: 0.8rem; font-size: 0.85rem; font-weight: 600;
    color: var(--color-ink-300); background: rgb(var(--fg) / 0.03); border: 1px solid rgb(var(--fg) / 0.06);
    transition: all 250ms var(--ease-out-expo);
  }
  .step-tab .num {
    display: grid; place-items: center; width: 1.3rem; height: 1.3rem; border-radius: 999px;
    font: 600 0.72rem/1 var(--font-mono); color: var(--color-ink-950); background: var(--c);
  }
  .step-tab.active { color: var(--color-ink-100); border-color: color-mix(in oklab, var(--c) 50%, transparent); background: color-mix(in oklab, var(--c) 10%, transparent); }
  .step-tab.done { opacity: 0.55; }

  .step { transition: border-color 300ms, opacity 300ms, transform 300ms var(--ease-out-expo); }
  .step.now { border-color: color-mix(in oklab, var(--c) 45%, transparent); box-shadow: 0 0 0 1px color-mix(in oklab, var(--c) 25%, transparent), 0 18px 40px -20px color-mix(in oklab, var(--c) 50%, transparent); }
  .step.done { opacity: 0.5; }
  .step .badge {
    display: grid; place-items: center; width: 1.9rem; height: 1.9rem; flex-shrink: 0; border-radius: 999px;
    font: 600 0.85rem/1 var(--font-mono); color: var(--color-ink-950); background: var(--c);
  }
  .chip {
    display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.2rem 0.55rem; border-radius: 999px;
    color: var(--color-ink-100); background: rgb(var(--fg) / 0.07);
  }
  .chip.ok { color: var(--color-s1); background: rgb(45 212 191 / 0.12); }
  .chip.muted { color: var(--color-ink-400); background: transparent; border: 1px solid rgb(var(--fg) / 0.07); font-family: var(--font-mono); }

  .alt {
    padding: 0.35rem 0.7rem; border-radius: 999px; color: var(--color-ink-300);
    background: rgb(var(--fg) / 0.03); border: 1px solid rgb(var(--fg) / 0.07); font-family: var(--font-mono);
  }
  .alt.active { color: var(--color-ink-950); background: var(--color-ink-100); }

  .hand {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 6.5rem; padding: 0.75rem; border-radius: 0.9rem;
    background: rgb(var(--fg) / 0.03); border: 1px solid rgb(var(--fg) / 0.06);
    transition: all 250ms var(--ease-out-expo);
  }
  .hand.selected { border-color: rgb(251 191 36 / 0.5); background: rgb(251 191 36 / 0.07); }
  .hand.used { opacity: 0.6; }

  .stepper {
    width: 1.4rem; height: 1.4rem; border-radius: 0.45rem; color: var(--color-ink-300);
    background: rgb(var(--fg) / 0.05);
  }
  .stepper:hover { background: rgb(var(--fg) / 0.1); color: white; }

  .range { appearance: none; height: 6px; border-radius: 999px; background: linear-gradient(90deg, var(--color-s1), var(--color-s2), var(--color-s3)); }
  .range::-webkit-slider-thumb {
    appearance: none; width: 18px; height: 18px; border-radius: 50%; background: white;
    box-shadow: 0 0 0 4px rgb(var(--fg) / 0.15), 0 2px 6px rgb(0 0 0 / 0.5); cursor: pointer;
  }
  .range::-moz-range-thumb { width: 18px; height: 18px; border: 0; border-radius: 50%; background: white; }
</style>
