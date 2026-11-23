import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const standard = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }
function store(value) {
  const listeners = new Set()
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { value = next; for (const fn of [...listeners]) fn() } }
}
function events() {
  const listeners = new Map()
  return { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key),
    dispatch: (key, event) => listeners.get(key)?.(event) }
}
function fixture(counts = { A: 150, B: 170, C: 150, D: 1000 }, { deferTransition = false } = {}) {
  class Stream {
    constructor(kind = 'session') { this.address = { kind } }
    follow(page, signal) { return { page, signal } }
    repairRequest(page) { return page }
    readPage(page, throughSeq, signal) { return { page, throughSeq, signal } }
  }
  const window = events(), document = events()
  // 过渡只关心「面板会话标记」和「首屏高度」，这里给出足够回放的 DOM 桩。
  const observers = [], transitions = []
  const panel = { sessionId: 'A', scrollHeight: 500, nodes: 1 }
  const head = { kids: [], appendChild: el => head.kids.push(el) }
  document.head = head
  document.documentElement = {}
  document.querySelector = selector => selector === '[data-conversation-content]' && panel.sessionId ? {
    getAttribute: key => key === 'data-conversation-session' ? panel.sessionId : undefined,
    querySelector: inner => inner === '[data-chat-flow]' ? {
      // 宿主先挂载空 flow，再异步补消息节点。
      querySelector: () => panel.nodes > 0 ? { kind: 'node' } : null,
    } : { scrollHeight: panel.scrollHeight },
    offsetHeight: panel.scrollHeight,
  } : null
  document.createElement = () => ({ attrs: {}, setAttribute(key, value) { this.attrs[key] = value }, remove() { head.kids = head.kids.filter(el => el !== this) } })
  document.startViewTransition = callback => {
    const record = { callback, finished: deferTransition ? new Promise(() => {}) : Promise.resolve(),
      skipTransition() { this.skipped = true } }
    transitions.push(record)
    if (!deferTransition) record.done = callback()
    return record
  }
  window.matchMedia = () => ({ matches: false })
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe() {}
    disconnect() { this.off = true }
  }
  let plugin, stop, main, now = 0, serial = 0
  const frames = new Map(), timers = new Map(), live = new Map(), opens = new Map()
  window.__ModuleLoader__ = { load(row) {
    assert.equal(row.id, 'dsh-switch-fast')
    plugin = row.factory(name => { assert.equal(name, '@deepseek-ai/dsh-api-session-controller/client'); return { SessionEventStream: Stream } })
  } }
  runInNewContext(source, { window, document, MutationObserver, Date: { now: () => now }, performance: { now: () => now },
    requestAnimationFrame(fn) { frames.set(++serial, fn); return serial }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout(fn, ms) { timers.set(++serial, [now + ms, fn]); return serial }, clearTimeout: id => timers.delete(id) })
  const selection = store({}), generation = store(1), workspaceList = store({ archivedSessionIds: [] })
  const list = store({ byId: Object.fromEntries(Object.keys(counts).map(id => [id, {}])) })
  const sessions = { list, binding: id => live.get(id)?.binding, retain(id) {
    let item = live.get(id)
    if (!item) {
      opens.set(id, (opens.get(id) ?? 0) + 1)
      item = { refs: 0, binding: { session: { getSnapshot: () => ({ openState: 'open' }) }, eventSource: { getSnapshot: () => ({ entries: { length: counts[id] } }) } } }
      live.set(id, item)
    }
    item.refs++
    return { ready: Promise.resolve(item.binding), release() { if (--item.refs === 0) live.delete(id) } }
  } }
  const services = { sessions, uiWorkspace: { selection }, workspaces: { list: workspaceList }, connection: { generation } }
  plugin.apply({ get: key => services[key], effect: fn => { stop = fn() } })
  return { Stream, document, workspaceList, generation, live, opens, list, stop, panel, transitions, head, observers,
    select(id, subagentAddress) {
      const next = sessions.retain(id)
      // 宿主先选中、下一帧才重渲染面板；这里保持同样的先后顺序。
      selection.set({ sessionId: id, subagentAddress })
      main?.release(); main = next
    },
    render(id, nodes = 1) {
      panel.sessionId = id
      panel.nodes = nodes
      for (const observer of observers) if (!observer.off) observer.callback()
    },
    paint() { for (const [id, fn] of [...frames]) { frames.delete(id); fn() } },
    advance(ms) { now += ms; for (const [id, [due, fn]] of [...timers]) if (due <= now) { timers.delete(id); fn() } },
  }
}

test('shrinks open and ordinary older pages without changing jump, repair or subagent requests', () => {
  const f = fixture(), stream = new f.Stream(), signal = new AbortController().signal
  const earlier = { ...standard, beforeSeq: 220 }
  const jump = { ...earlier, turnWindow: { minMessages: 200, minTurns: 2 } }
  assert.equal(stream.follow(standard, signal).page.turnWindow.minMessages, 1)
  assert.equal(stream.follow(standard, signal).signal, signal)
  assert.equal(stream.repairRequest(standard), standard)
  const read = stream.readPage(earlier, 500, signal)
  assert.equal(read.page.maxMessages, 48)
  assert.equal(read.page.beforeSeq, 220)
  assert.equal(read.throughSeq, 500)
  assert.equal(read.signal, signal)
  assert.equal(stream.readPage(jump).page, jump)
  assert.equal(stream.readPage(standard).page, standard)
  assert.equal(new f.Stream('subagent').readPage(earlier).page, earlier)
  f.stop()
  assert.equal(stream.readPage(earlier).page, earlier)
  assert.equal(stream.follow(standard, signal).page, standard)
})

test('cross-fades a session switch only once the new session really has messages', async () => {
  const f = fixture()
  assert.equal(f.head.kids.length, 1, 'installs its transition stylesheet')
  assert.match(f.head.kids[0].textContent, /view-transition-name: dsh-switch-fast-panel/)

  f.select('A')
  f.render('A')
  assert.equal(f.transitions.length, 0, 'first selection has no previous panel to keep')

  // 旧面板仍在时开始过渡，回调要一直等到新会话真正渲染出消息才放行。
  f.select('B')
  assert.equal(f.transitions.length, 1)
  const { done } = f.transitions[0]
  let released = false
  done.then(() => { released = true })
  await Promise.resolve()

  // 面板已换成 B，但只有「载入历史」的空容器：此时放行就是对着空白淡入。
  f.render('B', 0)
  f.paint(); f.paint(); f.paint()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(released, false, 'a mounted but still-empty panel must not release the old frame')

  // 消息节点到位、高度稳定后才放行。
  f.render('B', 1)
  f.paint(); f.paint(); f.paint()
  await Promise.resolve(); await Promise.resolve()
  assert.ok(released, 'released once the new session has messages and a stable height')

  // 全新空会话（根本没有 flow 之外的节点）也要能自愈，不能卡住旧画面。
  f.select('C')
  f.render('C', 1)
  f.paint(); f.paint(); f.paint()
  await Promise.resolve(); await Promise.resolve()

  f.stop()
  assert.equal(f.head.kids.length, 0, 'removes its stylesheet on dispose')
})

test('skips the cross-fade while the page is hidden', () => {
  const f = fixture()
  f.select('A')
  f.render('A')
  assert.equal(f.transitions.length, 0)
  // 页面不可见时不值得为一个看不见的过渡占合成帧，直接走原生切换。
  f.document.visibilityState = 'hidden'
  f.select('B')
  assert.equal(f.transitions.length, 0, 'no transition is started in a hidden page')
  f.document.visibilityState = 'visible'
  f.render('B')
  f.paint()
  f.select('C')
  assert.equal(f.transitions.length, 1, 'visible page still cross-fades')
  f.stop()
})

test('reuses two prior conversations and evicts on budget, archive, reconnect or expiry', () => {
  const f = fixture({ A: 150, B: 170, C: 150, D: 1300 })
  for (const id of ['A', 'B', 'C', 'A']) f.select(id)
  assert.equal(f.opens.get('A'), 1)
  assert.deepEqual([...f.live.keys()], ['A', 'B', 'C'])
  f.workspaceList.set({ archivedSessionIds: ['B'] })
  assert.ok(!f.live.has('B'))
  f.select('D'); f.select('C')
  assert.deepEqual([...f.live.keys()], ['C', 'D'])
  f.advance(90_000)
  assert.deepEqual([...f.live.keys()], ['C'])
  f.select('A'); f.generation.set(2)
  assert.deepEqual([...f.live.keys()], ['A'])
  f.stop()
})

test('holds the cross-fade while the new panel is still growing', async () => {
  const f = fixture()
  f.select('A')
  f.render('A')
  f.select('B')
  const { done } = f.transitions[0]
  let released = false
  done.then(() => { released = true })

  // 消息节点已就位，但高度第一帧 500、下一帧变成 780（图片/代码块撑开）：
  // 这时候淡入就是边淡边跳，必须先等高度稳定。
  f.render('B', 1)
  f.paint()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(released, false, 'a panel that just changed height is not stable yet')

  f.panel.scrollHeight = 780
  f.paint(); f.paint()
  await Promise.resolve(); await Promise.resolve()
  assert.ok(released, 'released once two frames agree on the height')

  // 一直在长的面板也不能把旧画面钉到上限：最多再等 3 帧就放行。
  f.select('C')
  const taller = f.transitions[1]
  let secondReleased = false
  taller.done.then(() => { secondReleased = true })
  let height = 900
  f.render('C', 1)
  for (let index = 0; index < 6 && !secondReleased; index += 1) {
    f.panel.scrollHeight = height += 10
    f.paint()
    await Promise.resolve(); await Promise.resolve()
  }
  assert.ok(secondReleased, 'a continuously growing panel still releases within its frame budget')
  f.stop()
})

test('cross-fade stays a pure opacity fade and respects reduced motion', () => {
  const f = fixture()
  const css = f.head.kids[0].textContent
  const animation = /::view-transition-new\(dsh-switch-fast-panel\) \{ animation: (\d+)ms ([^;]+); \}/.exec(css)
  assert.ok(animation, 'the new panel gets an explicit animation')
  assert.equal(animation[1], '180', 'the fade is brisk enough not to feel laggy')
  // 位移让新旧两版文字在淡入期间错位，字形发虚，比不动更像抖动。
  assert.doesNotMatch(css, /translateY|translate3d|scale\(/, 'no transform: the two panels must stay aligned')
  assert.match(css, /@keyframes dsh-switch-fast-in \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  f.stop()
})

test('releases the previous wait when a switch is overtaken by a faster one', async () => {
  const f = fixture()
  f.select('A')
  f.render('A')
  f.select('B')
  assert.equal(f.transitions.length, 1)
  const first = f.transitions[0]
  let firstReleased = false
  first.done.then(() => { firstReleased = true })
  f.render('B', 0)
  f.paint(); f.paint()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(firstReleased, false, 'still waiting for the first switch to paint')

  // 没等 B 出内容就切到 C：旧等待必须立刻放行，否则它还会挂着 document 观察器再等 240ms。
  f.select('C')
  assert.equal(f.transitions.length, 2, 'the newer switch still gets its own transition')
  await Promise.resolve(); await Promise.resolve()
  assert.ok(firstReleased, 'the overtaken transition is finished instead of running out its cap')
  assert.equal(f.observers.filter(observer => !observer.off).length, 1, 'only the live wait keeps an observer')
  f.stop()
  assert.equal(f.observers.filter(observer => !observer.off).length, 0, 'dispose leaves no observer behind')
})

test('finishes a pending switch when the plugin is disposed', async () => {
  const f = fixture()
  f.select('A')
  f.render('A')
  f.select('B')
  assert.equal(f.transitions.length, 1)
  let released = false
  f.transitions[0].done.then(() => { released = true })
  f.stop()
  await Promise.resolve(); await Promise.resolve()
  assert.ok(released, 'the pending wait is released on teardown')
  assert.equal(f.observers.filter(observer => !observer.off).length, 0)
})

test('finishes a pending wait when the page goes to the background', async () => {
  const f = fixture()
  f.select('A')
  f.render('A')
  f.select('B')
  assert.equal(f.transitions.length, 1)
  let released = false
  f.transitions[0].done.then(() => { released = true })
  f.render('B', 0)
  f.paint(); f.paint()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(released, false, 'still waiting for the new session to paint messages')

  // 后台标签页不该为一个看不见的过渡继续跑 rAF：可见性一变就结束等待。
  f.document.visibilityState = 'hidden'
  f.document.dispatch('visibilitychange')
  await Promise.resolve(); await Promise.resolve()
  assert.ok(released, 'a hidden page releases the pending transition immediately')
  assert.equal(f.observers.filter(observer => !observer.off).length, 0, 'its observer is gone')
  f.advance(1000)
  f.stop()
})

test('obsolete browser transition callbacks never install observers', () => {
  const f = fixture(undefined, { deferTransition: true })
  f.select('A')
  f.select('B')
  f.render('B')
  f.select('C')
  const [old, current] = f.transitions
  assert.equal(old.skipped, true)
  assert.equal(old.callback(), undefined)
  assert.equal(f.observers.length, 0)
  f.stop()
  assert.equal(current.skipped, true)
  assert.equal(current.callback(), undefined)
  assert.equal(f.observers.length, 0)
})
