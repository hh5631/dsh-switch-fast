window.__ModuleLoader__.load({
  id: 'dsh-switch-fast',
  factory: (require) => {
    const KEEP_MS = 90_000
    const MAX_CACHED = 2
    const CACHE_ENTRY_BUDGET = 1_400
    const panelSelector = '[data-conversation-content]'
    const TRANSITION_NAME = 'dsh-switch-fast-panel'
    const STYLE_ATTR = 'data-dsh-switch-fast'

    function isStandardPage(request) {
      return request?.maxMessages === 500 && request.turnWindow?.minMessages === 50 && request.turnWindow?.minTurns === 2
    }
    function replaceMethod(prototype, key, wrap) {
      const original = prototype && Object.getOwnPropertyDescriptor(prototype, key)
      if (!original?.writable || typeof original.value !== 'function') return () => {}
      const replacement = wrap(original.value)
      Object.defineProperty(prototype, key, { ...original, value: replacement })
      return () => {
        if (prototype[key] === replacement) Object.defineProperty(prototype, key, original)
      }
    }
    function reduceHistoryPages(Stream) {
      const prototype = Stream?.prototype
      const undoOpening = replaceMethod(prototype, 'follow', original => function (request, signal) {
        const page = this.address?.kind === 'session' && isStandardPage(request)
          ? { ...request, maxMessages: 24, turnWindow: { minMessages: 1, minTurns: 1 } } : request
        return original.call(this, page, signal)
      })
      const undoEarlier = replaceMethod(prototype, 'readPage', original => function (request, throughSeq, signal) {
        // beforeSeq 区分向上翻页与实时流补洞；轮次跳转的原生请求使用另一套预算。
        const earlier = this.address?.kind === 'session' && Number.isSafeInteger(request?.beforeSeq) && request.beforeSeq >= 0 && isStandardPage(request)
        const page = earlier ? { ...request, maxMessages: 48, turnWindow: { minMessages: 10, minTurns: 1 } } : request
        return original.call(this, page, throughSeq, signal)
      })
      return () => { undoEarlier(); undoOpening() }
    }

    function keepRecent({ selection, sessions, workspaces, generation }) {
      if (!selection?.getSnapshot || !selection.subscribe || !sessions?.binding
        || !sessions.retain || !sessions.list?.subscribe || !workspaces?.list?.subscribe) return () => {}

      let current = selection.getSnapshot()
      const cached = new Map()
      function drop(id) {
        const entry = cached.get(id)
        if (!entry) return
        cached.delete(id)
        clearTimeout(entry.timer)
        entry.reference.release()
      }
      function clear() { for (const id of [...cached.keys()]) drop(id) }
      function eligible(id) {
        const { byId } = sessions.list.getSnapshot()
        const row = Object.hasOwn(byId, id) ? byId[id] : undefined
        return !!row && !row.blank && !row.running && !row.parentId && row.origin !== 'subagent'
          && !workspaces.list.getSnapshot().archivedSessionIds.includes(id)
      }
      function prune() {
        for (const [id, entry] of [...cached]) if (entry.expires <= Date.now() || !eligible(id)) drop(id)
      }
      function trim() {
        let count = [...cached.values()].reduce((sum, entry) => sum + entry.records, 0)
        for (const [id, entry] of cached) {
          if (cached.size <= MAX_CACHED && count <= CACHE_ENTRY_BUDGET) break
          count -= entry.records
          drop(id)
        }
      }
      function onSelection() {
        const previous = current
        current = selection.getSnapshot()
        if (current.sessionId === previous.sessionId) return
        if (!current.sessionId) { clear(); return }
        // 宿主已取得新会话的主视图引用，可以放掉它的缓存引用；旧会话仍有主视图引用。
        drop(current.sessionId)
        prune()
        const id = previous.sessionId
        if (!id || previous.subagentAddress || !eligible(id)) return
        const binding = sessions.binding(id)
        const state = binding?.session.getSnapshot()
        if (state?.openState !== 'open' || state.removed || state.running) return
        const records = binding.eventSource?.getSnapshot()?.entries?.length
        if (!Number.isSafeInteger(records) || records === 0 || records > CACHE_ENTRY_BUDGET) return
        try {
          const reference = sessions.retain(id, { source: 'switchFast' })
          const entry = { reference, records, expires: Date.now() + KEEP_MS, timer: setTimeout(() => drop(id), KEEP_MS) }
          cached.set(id, entry)
          void reference.ready.catch(() => { if (cached.get(id) === entry) drop(id) })
          trim()
        } catch { /* 会话已退役时保持原生路径。 */ }
      }

      const off = [selection.subscribe(onSelection), sessions.list.subscribe(prune), workspaces.list.subscribe(prune)]
      if (generation?.subscribe) off.push(generation.subscribe(clear))
      window.addEventListener('pagehide', clear)
      return () => {
        off.forEach(unsubscribe => unsubscribe())
        window.removeEventListener('pagehide', clear)
        clear()
      }
    }

    // 切会话时宿主的顺序是「先清空面板、再异步装内容」：面板约 60ms 就换成新会话，
    // 消息却要 100~400ms 才出现，中间是空白加滚动位置从 0 跳到底部。这里用 View
    // Transitions 让旧画面多停留一小会儿再交叉淡入，把这段空白和跳变吃掉；但停留
    // 必须短，否则「等」本身会变成新的迟滞，所以用短上限兜底、到点就过渡。
    const SWITCH_CSS = `
[data-conversation-content] { view-transition-name: ${TRANSITION_NAME}; }
::view-transition-group(${TRANSITION_NAME}) { animation: none; }
::view-transition-old(root), ::view-transition-new(root) { animation: none; }
/* 旧画面必须保持不透明：宿主在新内容到达前有一段空窗，旧快照一淡出就是白屏。 */
::view-transition-old(${TRANSITION_NAME}) { animation: none; opacity: 1; }
::view-transition-new(${TRANSITION_NAME}) { animation: 200ms cubic-bezier(.16,1,.3,1) both dsh-switch-fast-in; }
@keyframes dsh-switch-fast-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }`

    function waitForPanel(sessionId, cap) {
      return new Promise(resolve => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          observer.disconnect()
          clearTimeout(timer)
          if (frame) cancelAnimationFrame(frame)
          resolve()
        }
        // 等新会话挂上真实消息节点（不是「载入历史」的空容器）就放行；
        // 内容迟迟不来也不能一直钉着旧画面，上限一到就交给交叉淡入。
        const ready = () => {
          frame = 0
          if (settled) return
          const panel = document.querySelector(panelSelector)
          if (!panel || panel.getAttribute('data-conversation-session') !== sessionId) return
          const flow = panel.querySelector('[data-chat-flow]')
          // 全新空会话没有 flow，挂载即算就绪。
          if (flow && flow.querySelector('[data-slot="conversation.chat.node"]') === null) return
          finish()
        }
        const observer = new MutationObserver(() => {
          if (!frame && !settled) frame = requestAnimationFrame(ready)
        })
        observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['data-conversation-session'],
        })
        const timer = setTimeout(finish, cap)
        frame = requestAnimationFrame(ready)
      })
    }

    function smoothSwitch(selection) {
      if (!selection?.getSnapshot || !selection.subscribe) return () => {}
      if (typeof document.startViewTransition !== 'function') return () => {}
      const panelOf = () => document.querySelector(panelSelector)
      const style = document.createElement('style')
      style.setAttribute(STYLE_ATTR, 'transition')
      style.textContent = SWITCH_CSS
      document.head.appendChild(style)
      let current = selection.getSnapshot()?.sessionId
      function onSelection() {
        const next = selection.getSnapshot()?.sessionId
        const previous = current
        current = next
        if (!previous || !next || previous === next) return
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return
        // 宿主若已先一步把面板换成新会话，此刻再捕获只会是自己淡入自己，直接跳过。
        if (panelOf()?.getAttribute('data-conversation-session') !== previous) return
        try {
          // 兜底上限贴着实测的消息到达时间：够等到首屏，又不会拖出额外的迟滞感。
          const transition = document.startViewTransition(() => waitForPanel(next, 240))
          void transition.finished.catch(() => {})
        } catch { /* 浏览器拒绝并发过渡时保持原生切换。 */ }
      }
      const off = selection.subscribe(onSelection)
      return () => {
        off()
        style.remove()
      }
    }

    return {
      inject: ['sessions', 'uiWorkspace', 'workspaces', 'connection'],
      apply(ctx) {
        ctx.effect(() => {
          let restore = () => {}
          try {
            const { SessionEventStream } = require('@deepseek-ai/dsh-api-session-controller/client')
            restore = reduceHistoryPages(SessionEventStream)
          } catch { /* 未识别的 Controller 保留原生历史窗口。 */ }
          const selection = ctx.get('uiWorkspace')?.selection
          const stopCache = keepRecent({ selection, sessions: ctx.get('sessions'), workspaces: ctx.get('workspaces'), generation: ctx.get('connection')?.generation })
          const stopSwitch = smoothSwitch(selection)
          return () => { stopSwitch(); stopCache(); restore() }
        }, 'dsh-switch-fast')
      },
    }
  },
})
