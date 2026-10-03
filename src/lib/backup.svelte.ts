/**
 * 조각 통계·판 기록 자동 백업 (worker/index.ts의 KV).
 *
 * 통계가 브라우저 하나에만 있어서 브라우저를 바꾸거나 데이터를 지우면 사라졌고, 사용자는 저장이 안 되는 줄도 몰랐다.
 * 통계가 바뀔 때마다 4초 뒤에 묶어서 올린다. 이 브라우저의 id(무작위)로 저장되므로 다른 브라우저 것과 섞이지 않는다.
 * 화면은 올라가지 않는다. 조각 횟수·판 점수·설정뿐이다.
 */
const ID_KEY = 'moamoa.backup.id'

export type BackupState = 'idle' | 'saving' | 'ok' | 'error'

class Backup {
  state = $state<BackupState>('idle')
  /** 마지막으로 올린 때 */
  at = $state(0)
  error = $state('')
  readonly id: string
  private timer = 0
  private pending: (() => unknown) | null = null

  constructor() {
    let id = ''
    try { id = localStorage.getItem(ID_KEY) ?? '' } catch { /* 사생활 보호 모드 */ }
    if (!/^[a-z0-9]{6,32}$/.test(id)) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('')
      try { localStorage.setItem(ID_KEY, id) } catch { /* 이번 창에서만 쓴다 */ }
    }
    this.id = id
  }

  /** 통계가 바뀌었다. 잠시 뒤 올린다 (연달아 바뀌면 마지막 것만) */
  schedule(snapshot: () => unknown) {
    this.pending = snapshot
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.flush(), 4000)
  }

  async flush() {
    const take = this.pending
    if (!take) return
    this.pending = null
    this.state = 'saving'
    try {
      const res = await fetch(`/api/stats/${this.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(take()) })
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      this.state = 'ok'
      this.at = Date.now()
      this.error = ''
    } catch (e) {
      // 다음에 통계가 바뀌면 다시 올린다
      this.state = 'error'
      this.error = e instanceof Error ? e.message : String(e)
      this.pending = take
    }
  }
}

export const backup = new Backup()
