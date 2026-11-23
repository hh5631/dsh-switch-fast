# dsh-switch-fast

原 `dsh-session-switch-fast`，适用于 DSH Web `0.2.2-rc.3` 和 `0.2.2-rc.5`。

- 普通对话首次打开时优先取最近一轮，原生消息预算从 500 收到 24；切回有缓存的对话时，复用原生 Session 和增量订阅。
- 向上翻阅时由 DSH 原生加载更早的消息并维持滚动位置。普通旧页的消息预算调整为 48，轮次跳转和子会话使用原生策略。
- 网页内最多缓存两个最近离开的空闲对话，每个最多 90 秒，接纳时合计最多 1,400 个事件条目。归档、删除、连接重置或离开页面会释放缓存。没有持久化或预读未打开的对话。
- 切换会话时用 View Transitions 做交叉淡入：旧画面保持不透明，等新会话真正渲染出消息、且高度连续两帧不再变化后再让新内容淡入（180ms，只做透明度，不做位移），吃掉宿主「先清空面板、再异步装内容」这段约 60~300ms 的空白帧和滚动跳变。空会话、子会话、减少动态效果偏好下走原生路径；浏览器不支持时自动跳过。

切换过渡只读 DOM 上的 `[data-conversation-content]`、`[data-chat-flow]`、消息节点标记和面板高度，不改宿主的渲染、滚动或状态。首屏最多再多量 3 帧高度，兜底上限仍是 240ms；高度一直在变（流式输出、长表格）时按当前高度放行，避免把「等」变成新的迟滞。

预算按 DSH 定义的消息计数，并非事件数或字节数。单个超大工具结果仍可能让一页偏重；应用的历史解析、React 渲染仍在 DSH 原来的链路上。本插件不改消息、附件、草稿或工具输出，也不接管其他面板的按钮。

```sh
# 方式一：预构建 tarball（推荐，无需构建授权）
dsh plugin --profile web add https://github.com/hh5631/dsh-switch-fast/releases/latest/download/dsh-switch-fast.tgz

# 方式二：直接从 GitHub 源码安装
dsh plugin --profile web add github:hh5631/dsh-switch-fast

# 方式三：本地克隆后安装
git clone https://github.com/hh5631/dsh-switch-fast.git
dsh plugin --profile web add link:$PWD/dsh-switch-fast
```

如果安装过旧名字，先移除 `dsh-session-switch-fast`，避免同时装两版。重启 DSH Web 并刷新网页后，启动时读取新的 bundle。可以从插件管理停用，或用 `dsh plugin --profile web remove dsh-switch-fast` 移除。
