/**
 * 늘 위에 떠 있는 작은 창 (Document Picture-in-Picture, Chrome·Edge 116+).
 *
 * 화면 공유는 게임이 창 모드일 때만 되므로, 게임 창 위에 작은 창을 띄워 두고
 * 보면서 바로 놓을 수 있게 한다. 창 안의 화면은 같은 상태(engine)를 그대로 쓰는
 * Svelte 컴포넌트라서 원래 탭과 똑같이 실시간으로 바뀐다.
 */
import { mount, unmount } from 'svelte'
import { engine } from './engine.svelte'
import { theme } from './theme.svelte'
import PipView from './components/PipView.svelte'

interface DocumentPictureInPicture {
  requestWindow(opts?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>
  window: Window | null
}
declare global {
  interface Window { documentPictureInPicture?: DocumentPictureInPicture }
}

class Pip {
  open = $state(false)
  readonly supported = typeof window !== 'undefined' && 'documentPictureInPicture' in window
  private win: Window | null = null

  async toggle() {
    if (this.win) { this.win.close(); return }
    await this.show()
  }

  async show() {
    const api = window.documentPictureInPicture
    if (!api) {
      engine.error = '이 브라우저는 작은 창(PiP)을 지원하지 않아요. Chrome이나 Edge 최신 버전에서 열어 주세요.'
      return
    }
    const win = await api.requestWindow({ width: 340, height: 720 })
    copyStyles(win.document)
    win.document.documentElement.lang = 'ko'
    win.document.title = '모아모아 도우미'
    // 작은 창도 원래 창과 같은 테마로, 바꾸면 같이 바뀐다
    const stopTheme = $effect.root(() => {
      $effect(() => { win.document.documentElement.dataset.theme = theme.current })
    })
    const app = mount(PipView, { target: win.document.body })
    this.win = win
    this.open = true
    engine.setTimerHost(win)
    win.addEventListener('pagehide', () => {
      unmount(app)
      stopTheme()
      this.win = null
      this.open = false
      engine.setTimerHost(window)
    }, { once: true })
  }
}

/** 원래 문서의 스타일을 PiP 문서로 옮긴다. 개발 중에는 <style>, 빌드 뒤에는 <link>로 들어 있다 */
function copyStyles(doc: Document) {
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    if (node instanceof HTMLLinkElement) {
      const link = doc.createElement('link')
      link.rel = 'stylesheet'
      link.href = node.href // 절대 주소. PiP 문서는 about:blank라 상대 주소가 풀리지 않는다
      doc.head.append(link)
    } else {
      doc.head.append(node.cloneNode(true))
    }
  }
}

export const pip = new Pip()
