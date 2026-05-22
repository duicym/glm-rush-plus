# GLM Coding 抢购助手 Plus

> 智谱 GLM Coding Plan 限时抢购自动化脚本（Tampermonkey 油猴脚本）  
> 基于 [glm-rush](https://github.com/qtaxm/glm-rush) v4.6 架构，全面增强自动参数捕获能力

## 🚀 核心改进

| 特性 | glm-rush v4.6 | glm-rush-plus v1.0 |
|------|------|------|
| 参数捕获 | **需要手动点击按钮** → 售罄时按钮禁用无法操作 | **自动捕获** — 绕过 Vue disabled 状态，强制触发真实购买按钮 |
| 捕获策略 | 单策略 (手动点击) | **三层策略**：DOM 按钮强制点击 → Vue PayComponent 方法直调 → 回退 fetch 触发 |
| 兼容性 | `@grant` 需要 GM_* API 权限 | `@grant none` — 零权限沙箱，纯浏览器 API |
| 通知 | `GM_notification` | `Notification` API，自动请求权限 |
| 域名覆盖 | `www.bigmodel.cn`, `bigmodel.cn` | 额外支持 `open.bigmodel.cn` |

## 功能特点

- **极速并发引擎** — 双模式并发：极速模式 10 路 + 普通模式 5 路，任一成功立即取消其余
- **自适应间隔** — 前 20 次零延迟爆发 → 30ms 快速重试 → 100ms 随机间隔，带 ±30% 抖动
- **preview + check 双重校验** — 获取 bizId 后调用 check 确认有效，EXPIRE 立即重试
- **4 层支付恢复** — 暴力清弹窗 → 缓存重点击 → 直接获取支付链接 → 兜底提醒
- **反检测** — 请求指纹随机化（X-Request-Id / X-Timestamp / Accept-Language）、JSON.parse 定向拦截、fetch/XHR toString 伪装、Shadow DOM 面板隔离
- **高精度定时** — requestAnimationFrame + performance.now，精度 ±2ms
- **配置持久化** — localStorage 保存所有配置，刷新不丢失
- **弹窗自动恢复** — MutationObserver 监控弹窗，自动关闭并重新触发，最多 3 次
- **快捷键** — `Alt+S` 开始 / `Alt+X` 停止 / `Alt+H` 隐藏面板
- **离开保护** — 抢购中离开页面时弹出确认提示

## 安装

### 方式 1：从 GitHub Raw 安装（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击安装：[glm-rush-plus.user.js](https://raw.githubusercontent.com/duicym/glm-rush-plus/main/glm-rush-plus.user.js)
3. Tampermonkey 自动弹出安装页面，点击 **安装**

### 方式 2：手动安装

1. 复制 `glm-rush-plus.user.js` 的内容
2. 打开 Tampermonkey → 添加新脚本 → 粘贴 → 保存

## 使用方法

1. 打开 [GLM Coding 页面](https://bigmodel.cn/glm-coding) 或 [open.bigmodel.cn/glm-coding](https://open.bigmodel.cn/glm-coding)
2. 右上角出现控制面板
3. **无需手动操作** — 脚本自动触发真实购买按钮，捕获请求参数（面板显示"已捕获: Max → product-xxx"）
4. 选择触发方式：
   - **主动抢购**：立即开始并发重试
   - **定时触发**：设定时间（默认 10:00:00），到点自动开始
5. 抢购成功后自动弹出支付页面 + 系统通知

## 工作原理

```
页面加载 (document-start)
        ↓
劫持 fetch / XMLHttpRequest  ← 在页面发请求之前
        ↓
等待 #app 渲染完成
        ↓
┌── 三层参数捕获 ──────────────────────────────────────────┐
│                                                          │
│  策略A: DOM 按钮强制点击                                  │
│    找到 Max 套餐卡片 → 解除 Vue disabled → click()       │
│                                                          │
│  策略B: Vue PayComponent 方法直调                         │
│    selectPayTypeFn('product-2fc421') 直接触发购买流程      │
│                                                          │
│  策略C: 回退 fetch                                       │
│    通过原生 fetch 发送请求，浏览器自动附加 cookie/header    │
│                                                          │
└──────────────────────────────────────────────────────────┘
        ↓
拦截器自动捕获真实 API 请求 (URL + method + body + headers)
        ↓
┌── 极速模式 (前5秒) ──┐
│  10路并发 × 零延迟   │
└──────────────────────┘
        ↓
┌── 普通模式 ──────────┐
│  5路并发 × 自适应间隔 │
└──────────────────────┘
        ↓
任一获取 bizId → check 校验 → 成功!
        ↓
4 层支付恢复 → 支付弹窗 → 扫码完成
```

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| targetPlan | `max` | 目标套餐: lite / pro / max |
| 并发路数 | 5 | 普通模式同时发起的请求数 |
| 极速并发 | 10 | 前 5 秒的高并发路数 |
| 极速时长 | 5s | 高并发持续多久 |
| 最大重试 | 2000 | 达到上限后停止 |
| 爆发次数 | 20 | 前 N 次零延迟 |
| 快速间隔 | 30ms | 爆发后的重试间隔 |
| 慢速间隔 | 100ms | 后期重试间隔中值 |
| 抖动 | ±30% | 间隔随机化幅度 |
| 抢购时间 | 10:00:00 | 每天定时触发时间 |

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt + S` | 启动主动抢购 |
| `Alt + X` | 停止所有操作 |
| `Alt + H` | 隐藏/显示面板 |

## 更新日志

### v1.0.0 (2026-05-22)

- **核心创新**：自动捕获参数，无需手动点击按钮
  - 策略A: 找到 Max 套餐按钮 → 绕过 Vue disabled → 强制点击触发真实请求
  - 策略B: Vue PayComponent 方法直调（`selectPayTypeFn`）
  - 策略C: 回退原生 fetch 触发
- **三层 auth token 提取**：Vuex Store → Cookie → localStorage
- **零权限沙箱**：`@grant none`，使用 `localStorage` / `Notification` API
- **域名扩展**：支持 `open.bigmodel.cn`
- 继承 glm-rush v4.6 全部功能：极速并发、反检测、弹窗恢复、高精度定时

## 致谢

本项目基于 [qtaxm/glm-rush](https://github.com/qtaxm/glm-rush) v4.6 架构开发，感谢原作者。

## License

MIT
