/**
 * 화면 공유로 받은 영상에서 프레임을 떠 온다.
 *
 * 판 위치를 찾기 전에는 화면 전체를, 찾은 뒤에는 판과 조각 카드가 들어가는
 * 영역만 잘라 읽는다. 전체 화면을 매번 읽으면 1프레임에 8MB씩 복사한다.
 */
import type { Grid } from './vision/read'

export interface Frame {
  image: ImageData
  /** 잘라 온 영역의 화면상 왼쪽 위. 격자 좌표를 화면 좌표로 되돌릴 때 쓴다 */
  ox: number
  oy: number
}

export class ScreenSource {
  readonly video: HTMLVideoElement
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  onEnded: (() => void) | null = null

  private constructor(readonly stream: MediaStream) {
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
    this.video.srcObject = stream
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.onEnded?.())
  }

  static async start(): Promise<ScreenSource> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 8, max: 15 }, cursor: 'never' } as MediaTrackConstraints,
      audio: false,
    })
    const src = new ScreenSource(stream)
    await src.video.play()
    return src
  }

  get width() { return this.video.videoWidth }
  get height() { return this.video.videoHeight }

  grab(region?: { x: number; y: number; w: number; h: number }): Frame | null {
    const W = this.width, H = this.height
    if (!W || !H) return null
    const r = region
      ? clampRect(region, W, H)
      : { x: 0, y: 0, w: W, h: H }
    if (this.canvas.width !== r.w || this.canvas.height !== r.h) {
      this.canvas.width = r.w
      this.canvas.height = r.h
    }
    this.ctx.drawImage(this.video, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    return { image: this.ctx.getImageData(0, 0, r.w, r.h), ox: r.x, oy: r.y }
  }

  stop() {
    for (const t of this.stream.getTracks()) t.stop()
    this.video.srcObject = null
  }
}

function clampRect(r: { x: number; y: number; w: number; h: number }, W: number, H: number) {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y))
  return { x, y, w: Math.max(1, Math.min(W - x, Math.ceil(r.w))), h: Math.max(1, Math.min(H - y, Math.ceil(r.h))) }
}

/** 판 + 오른쪽 카드 영역 (여유 한 칸) */
export function regionOf(g: Grid) {
  const p = g.pitch
  return { x: g.x - p, y: g.y - p, w: 15 * p, h: 18 * p }
}

/** 이미지 파일(스크린샷)을 프레임으로 */
export async function frameFromBlob(blob: Blob): Promise<Frame> {
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  return { image: ctx.getImageData(0, 0, c.width, c.height), ox: 0, oy: 0 }
}
