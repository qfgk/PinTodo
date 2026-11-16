# PinTodo · 常驻桌面待办清单

一个轻量、启动快、零卡顿的 Windows 桌面待办清单。基于 **Tauri 2 + SolidJS + Rust**，冷启动约 0.8 秒，常驻内存约 30 MB。

![PinTodo 截图](docs/screenshot.png)

## 特性

**桌面级常驻**

- 无边框透明卡片，可拖动/缩放，支持置顶；一键收进屏幕侧边变成呆萌小精灵胶囊（拖动可自由停靠、磁吸贴边）
- **挂起态**：按 `Win+D` 显示桌面时自动收缩为侧边胶囊、闭眼睡觉（Zzz），依然留在桌面上可点击唤回；切回其他窗口自动苏醒
- 单击胶囊立刻滑出完整窗口；关闭按钮可选择「收进侧边栏」或「退出」
- 托盘菜单、全局热键（`Ctrl+Alt+Space` 显隐 / `Ctrl+Alt+A` 快速添加）、开机自启

**待办管理**

- 自然语言快速录入：`!1/!2/!3` 优先级、`#标签`、`@清单`、`今天18:00` / `明天` / `周五` / `下周一` / `月底` / `每天8:30` / `每周三18点`
- 粘贴多行文本自动拆分为多条待办，支持 `Ctrl+Z` 撤销
- 清单视图按时间自动折叠分组：**今天 / 本周 / 本月 / 持续**，折叠偏好自动记忆
- 排序：收藏打星（★）→ 优先级 → 截止时间 → 原顺序，已完成沉底
- 任务描述（行内编辑、自动保存）、**进度反馈时间轴**（多次打卡记录历程）
- **标签体系**：任务可自由增删标签，点标签一键筛选、再点取消；弹窗内可勾选已有标签
- **挂起任务**：右键「挂起（暂缓处理）」，任务收进清单末尾「挂起」分组，不计入待办数与到期提醒，点击标记恢复
- **删除确认 + 回收站**：删除前二次确认，删除后进入回收站，可恢复/彻底删除/清空；支持自动清理规则（保留 7/30/90 天或永不）
- 历史日历：按天查看完成记录（次日起自动从清单隐藏），支持导出 Markdown / CSV（Excel 兼容）/ TXT
- 随手记：独立速记面板，`Esc` 保存返回，选中文字一键转为待办

**数据**

- 本地 JSON 存储（`%APPDATA%\PinTodo\`），150ms 防抖原子写入，启动自动滚动备份最近 7 份
- 支持导出/导入 JSON 与 todo.txt

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面运行时 | Tauri 2（WebView2） |
| 前端 | SolidJS + TypeScript + 原生 CSS（无 UI 框架、无虚拟 DOM） |
| 后端 | Rust（窗口状态机、Win32 消息钩子、提醒线程、托盘） |
| 测试 | Vitest 单元测试 + CDP 驱动的端到端冒烟测试 |

## 开发与构建

环境要求：

- Node.js 18+
- Rust（stable，MSVC toolchain）
- Visual Studio Build Tools（C++ 工作负载 + Windows 10/11 SDK）

```bash
npm install          # 安装前端依赖
npm run dev          # 前端热更新开发（配合 npm run tauri dev）
npm run tauri dev    # 完整开发模式
npm run build        # 类型检查 + 前端构建
npm run tauri build -- --no-bundle   # 生成 release 可执行文件
npm test             # Vitest 单元测试
```

产物：`src-tauri/target/release/todo.exe`（单文件，无需安装）。

## 快捷键

| 操作 | 按键 |
|---|---|
| 显隐 / 收进侧边 | `Ctrl+Alt+Space` |
| 全局快速添加 | `Ctrl+Alt+A` |
| 搜索 | `/` |
| 撤销 | `Ctrl+Z`（输入框内为原生文本撤销） |
| 收起 / 返回 | `Esc` |
| 完成选中任务 | `Space` / `Enter` |
| 快捷键与语法指南 | `?` |

## 测试

```bash
npm test                    # Vitest 单元测试
node tests/smoke.mjs        # CDP 端到端冒烟测试（需先构建 release）
node tests/repro-wind.mjs   # 真实 Win+D / 挂起态验证（Windows）
```

冒烟测试会备份并还原 `%APPDATA%\PinTodo\` 下的真实数据。

## 数据目录

`%APPDATA%\PinTodo\`

| 文件 | 说明 |
|---|---|
| `tasks.json` | 全部待办与历史完成记录 |
| `trash.json` | 回收站（删除的任务快照，按规则自动清理） |
| `settings.json` | 窗口位置、主题、置顶、清单与停靠边 |
| `scratchpad.txt` | 随手记内容 |
| `backup/` | 每次启动自动备份（保留最近 7 份） |

## 友情链接
LINUX DO —— 真诚分享、友好讨论的技术社区，本项目的交流与反馈也发布于此

## 许可

[MIT](LICENSE)
