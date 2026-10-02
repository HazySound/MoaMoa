<script lang="ts">
  import { COLS, ROWS } from '../core/board'
  import { anchorCell, type Plan } from '../core/solver'
  import type { Frame } from '../capture'
  import type { Grid } from '../vision/read'

  /*
   * 실제 게임 판 그림 위에 놓을 칸을 칠해서 보여 준다.
   * 단순화한 판보다 게임 화면과 바로 맞춰 보기 쉽다. 화면 공유 프레임에서 판 부분만 잘라 쓴다.
   */
  let { frame, grid, plan, focus, stepIdx, dot = null }: {
    frame: Frame | null
    grid: Grid | null
    plan: Plan | null
    focus: number
    stepIdx: number
    /** 점 찍기를 먼저 쓸 칸 */
    dot?: { r: number; c: number } | null
  } = $props()

  const STEP_COLORS = ['#10b981', '#f59e0b', '#f43f5e']

  let canvas: HTMLCanvasElement | undefined = $state()
  const scratch = document.createElement('canvas')
  let t = $state(0)

  // 놓을 칸을 깜빡이게 하려고 시간을 흘린다
  $effect(() => {
    // PiP 창 안에서는 그 창의 타이머를 쓴다. 원래 탭이 뒤에 있으면 그 탭 타이머는 느려진다
    const win = canvas?.ownerDocument.defaultView ?? window
    const id = win.setInterval(() => (t = (t + 1) % 1000), 60)
    return () => win.clearInterval(id)
  })

  $effect(() => {
    if (!canvas || !frame || !grid) return
    const { image, ox, oy } = frame
    const p = grid.pitch
    const gx = grid.x - ox, gy = grid.y - oy
    const W = Math.round(COLS * p), H = Math.round(ROWS * p)
    if (scratch.width !== image.width || scratch.height !== image.height) {
      scratch.width = image.width
      scratch.height = image.height
    }
    scratch.getContext('2d')!.putImageData(image, 0, 0)
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(scratch, gx, gy, W, H, 0, 0, W, H)

    if (dot) {
      // 점 찍기 먼저: 파란 동그라미
      ctx.lineWidth = Math.max(3, p / 9)
      ctx.strokeStyle = '#0b1220'
      ctx.beginPath(); ctx.arc((dot.c + 0.5) * p, (dot.r + 0.5) * p, p * 0.42, 0, Math.PI * 2); ctx.stroke()
      ctx.strokeStyle = '#38bdf8'
      ctx.lineWidth = Math.max(2, p / 14)
      ctx.beginPath(); ctx.arc((dot.c + 0.5) * p, (dot.r + 0.5) * p, p * 0.42, 0, Math.PI * 2); ctx.stroke()
    }
    const step = plan?.steps[focus]
    if (!step) return
    // 게임판이 청록이라 칠한 칸이 묻히지 않게 진하게 칠하고 짙은 테두리 + 흰 테두리를 두른다
    const pulse = 0.82 + 0.13 * Math.sin(t / 3)
    const color = STEP_COLORS[focus % 3]
    const lw = Math.max(2, p / 12)
    for (let i = 0; i < step.shape.h; i++) for (let j = 0; j < step.shape.w; j++) {
      if (!((step.shape.rows[i] >> j) & 1)) continue
      const x = (step.c + j) * p, y = (step.r + i) * p
      ctx.globalAlpha = pulse
      ctx.fillStyle = color
      ctx.fillRect(x + 2, y + 2, p - 4, p - 4)
      ctx.globalAlpha = 1
      ctx.lineWidth = lw * 1.8
      ctx.strokeStyle = '#0b1220'
      ctx.strokeRect(x + 2, y + 2, p - 4, p - 4)
      ctx.lineWidth = lw
      ctx.strokeStyle = '#ffffff'
      ctx.strokeRect(x + 2, y + 2, p - 4, p - 4)
    }
    // 지워질 줄
    ctx.globalAlpha = 0.18 + 0.1 * Math.sin(t / 3)
    ctx.fillStyle = '#ffffff'
    for (const r of step.cleared) ctx.fillRect(0, r * p, W, p)
    ctx.globalAlpha = 1
    // 커서를 둘 칸
    const [ar, ac] = anchorCell(step.shape, step.r, step.c)
    ctx.beginPath()
    ctx.arc((ac + 0.5) * p, (ar + 0.5) * p, p * 0.18, 0, Math.PI * 2)
    ctx.fillStyle = '#111827'
    ctx.fill()
    ctx.lineWidth = Math.max(2, p / 14)
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    void stepIdx
  })
</script>

{#if frame && grid}
  <canvas bind:this={canvas} class="h-auto w-full rounded-[14px]"></canvas>
{:else}
  <div class="grid aspect-[10/16] w-full place-items-center rounded-[14px] bg-ink-900 text-xs text-ink-400">화면 공유를 시작하면 실제 화면이 보여요</div>
{/if}
