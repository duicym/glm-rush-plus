# GLM Coding 抢购助手 Plus

> 智谱 GLM Coding Plan 限时抢购自动化脚本（Tampermonkey 油猴脚本）  
> 基于 [glm-rush](https://github.com/qtaxm/glm-rush) v4.6 架构，全面增强自动参数捕获能力

> ⚠️ **免责声明**：本脚本仅供学习交流使用，使用抢购脚本可能违反平台使用条款，请自行承担风险。

## 🚀 核心改进

| 特性 | glm-rush v4.6 | glm-rush-plus v1.2 |
|------|------|------|
| 参数捕获 | **需要手动点击按钮** → 售罄时按钮禁用无法操作 | **自动捕获** — 绕过 Vue disabled 状态，强制触发真实购买按钮 |
| 捕获策略 | 单策略 (手动点击) | **三层策略**：DOM 按钮强制点击 → Vue PayComponent 方法直调 → 回退 fetch 触发 |
| 兼容性 | `@grant` 需要 GM_* API 权限 | `@grant none` — 零权限沙箱，纯浏览器 API |
| 通知 | `GM_notification` | `Notification` API，自动请求权限 |
| 域名覆盖 | `www.bigmodel.cn`, `bigmodel.cn` | 额外支持 `open.bigmodel.cn` |
| 令牌处理 | 无自动刷新 | **自动检测令牌过期并刷新** |

## 功能特点

- **极速并发引擎** — 双模式并发：极速模式 2 路 + 普通模式 1 路，防 WAF 检测
- **自适应间隔** — 400ms 快速重试 → 800ms 随机间隔，带 ±100% 抖动
- **preview + check 双重校验** — 获取 bizId 后调用 check 确认有效，EXPIRE 立即重试
- **4 层支付恢复** — 暴力清弹窗 → 缓存重点击 → 直接获取支付链接 → 兜底提醒
- **反检测** — 请求指纹随机化（X-Request-Id / X-Timestamp / Accept-Language）、JSON.parse 定向拦截、fetch/XHR toString 伪装、Shadow DOM 面板隔离、模拟鼠标移动
- **高精度定时** — 服务器时间同步 + performance.now，精度 ±2ms
- **配置持久化** — localStorage 保存所有配置，刷新不丢失
- **弹窗自动恢复** — MutationObserver 监控弹窗，自动关闭并重新触发，最多 3 次
- **令牌自动刷新** — 每次请求自动获取最新 token，检测 401 错误自动处理
- **人数过多按钮处理** — 自动识别并强制点击"抢购人数过多"按钮，恢复为可点击状态
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
┌── 极速模式 (前3秒) ─┐
│  2路并发 × 低延迟   │
└──────────────────────┘
        ↓
┌── 普通模式 ──────────┐
│  1路并发 × 自适应间隔 │
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
| concurrency | `1` | 普通模式并发数（防 WAF 建议单路） |
| turboConcurrency | `2` | 极速模式并发数（前 3 秒） |
| turboSec | `3` | 极速模式持续时长（秒） |
| maxRetry | `500` | 最大重试次数 |
| burstCount | `0` | 零延迟爆发次数（0 = 无爆发） |
| fastDelay | `400` | 快速阶段延迟（ms） |
| slowDelay | `800` | 慢速阶段延迟（ms） |
| jitter | `1.0` | 随机抖动幅度（100% = 0~2倍延迟） |
| rushTime | `10:00:00` | 定时抢购时间 |
| autoCapture | `true` | 是否自动捕获参数 |
| mouseSimulation | `true` | 是否模拟鼠标移动 |
| recoveryMax | `3` | 弹窗恢复最大次数 |
| logMax | `100` | 最大日志条数 |

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt + S` | 启动主动抢购 |
| `Alt + X` | 停止所有操作 |
| `Alt + H` | 隐藏/显示面板 |

## FAQ / 常见问题

### Q: 令牌过期/401 错误怎么办？
A: v1.2.0 已支持自动检测令牌过期并刷新 token。如果持续报 401，请刷新页面重新登录。

### Q: 为什么捕获不到参数？
A: 
1. 确认已登录 bigmodel.cn 或 open.bigmodel.cn
2. 确认页面已渲染完成（看到套餐卡片）
3. 点击面板上的 🔄 按钮手动重新捕获
4. 检查浏览器控制台是否有脚本报错

### Q: 按钮显示"抢购人数过多"无法点击？
A: 脚本会自动识别并强制点击该按钮，解除 disabled 状态。如无效，可手动点击面板上的"主动抢购"。

### Q: WAF 封禁（405）怎么办？
A: 脚本会自动停止并冷却 5 分钟。建议：
- 降低并发数（concurrency 设为 1）
- 增加延迟（fastDelay/slowDelay 调大）
- 更换网络环境后清除冷却

### Q: 如何提高抢购成功率？
A: 
- 使用定时触发，提前打开页面等待
- 保持网络稳定，避免高延迟
- 不要同时开多个浏览器标签抢购
- 适当调整并发和延迟参数，避免触发 WAF

## 故障排除

| 问题 | 可能原因 | 解决方法 |
|------|---------|---------|
| 面板不显示 | 脚本未启用/域名不匹配 | 检查 Tampermonkey 是否启用，确认访问的是 bigmodel.cn 或 open.bigmodel.cn |
| 一直显示"等待捕获" | 页面未渲染/未登录 | 刷新页面，确认已登录 |
| 抢购后无响应 | 令牌过期/WAF 拦截 | 重新登录或等待冷却 |
| 支付弹窗不出现 | 弹窗被拦截 | 检查浏览器是否拦截弹窗，允许 bigmodel.cn 弹窗 |

## 更新日志

### v1.2.0 (2026-06-15)

- **令牌过期自动处理**：检测响应体中 `code: 401` 错误，自动刷新 token 并重试
- **Token 获取优化**：cookie 优先于 localStorage，每次请求强制使用最新 token
- **人数过多按钮修复**：改进 `findBuyButton` 逻辑，支持强制点击并恢复按钮文字
- **性能优化**：
  - Vue busy 状态：改用 MutationObserver 替代轮询
  - 定时器：使用递归 setTimeout 替代 setInterval，减少 CPU 占用
  - UI 刷新：添加 16ms 防抖机制
  - JSON.parse 劫持：添加商品相关检测，缩小影响范围
- **时间同步优化**：使用 HEAD 请求避免副作用，添加多个备用时间源
- **完善错误通知**：令牌过期时发送系统通知

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
