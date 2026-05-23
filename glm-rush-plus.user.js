// ==UserScript==
// @name         智谱 GLM Coding 抢购助手 Plus
// @namespace    https://github.com/duicym/glm-rush-plus
// @version      1.0.2
// @description  自动捕获真实API参数 + 补全智谱自定义Headers (bigmodel-org/project) + WAF检测 + 极速并发
// @author       duicym
// @homepage     https://github.com/duicym/glm-rush-plus
// @supportURL   https://github.com/duicym/glm-rush-plus/issues
// @match        *://www.bigmodel.cn/*
// @match        *://open.bigmodel.cn/*
// @match        *://bigmodel.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════
    //  配置
    // ═══════════════════════════════════════════
    const DEFAULT_CFG = {
        targetPlan: 'max',     // 目标套餐: lite / pro / max
        productIdOverride: null, // 如果指定了 productId，直接用它，否则自动从页面提取
        concurrency: 5,
        turboConcurrency: 10,
        turboSec: 5,
        maxRetry: 2000,
        burstCount: 20,
        fastDelay: 30,
        slowDelay: 100,
        jitter: 0.3,
        recoveryMax: 3,
        logMax: 100,
        rushTime: '10:00:00',
        autoCapture: true,    // 自动从页面提取参数（无需手动点击）
        PREVIEW: '/api/biz/pay/preview',
        CHECK: '/api/biz/pay/check',
    };

    function loadCfg() {
        try {
            const saved = localStorage.getItem('glm_rush_plus_cfg');
            if (saved) return { ...DEFAULT_CFG, ...JSON.parse(saved) };
        } catch {}
        return { ...DEFAULT_CFG };
    }
    function saveCfg(cfg) {
        const { PREVIEW, CHECK, ...save } = cfg;
        try { localStorage.setItem('glm_rush_plus_cfg', JSON.stringify(save)); } catch {}
    }

    const CFG = loadCfg();

    // ═══════════════════════════════════════════
    //  状态
    // ═══════════════════════════════════════════
    let state = {
        status: 'idle',
        count: 0,
        bizId: null,
        captured: null,
        cache: null,
        lastSuccess: null,
        proactive: false,
        timerId: null,
        logs: [],
        stats: { total: 0, success: 0, errors: 0, avgMs: 0, startTime: 0 },
    };

    function setState(patch) {
        state = { ...state, ...patch };
        refreshUI();
    }

    // 恢复上次捕获的请求
    try {
        const saved = sessionStorage.getItem('glm_rush_plus_captured');
        if (saved) state.captured = JSON.parse(saved);
    } catch {}

    let stopRequested = false;
    let recovering = false;
    let recoveryAttempts = 0;
    let _shadowRef = null;

    // ═══════════════════════════════════════════
    //  工具
    // ═══════════════════════════════════════════
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const jitteredDelay = base => Math.round(base * (1 + (Math.random() * 2 - 1) * CFG.jitter));

    function getDelay(attempt) {
        if (attempt <= CFG.burstCount) return 0;
        if (attempt <= 50) return jitteredDelay(CFG.fastDelay);
        return jitteredDelay(CFG.slowDelay);
    }

    function log(msg, level = 'info') {
        const entry = { ts: ts(), msg, level };
        const logs = [...state.logs, entry];
        if (logs.length > CFG.logMax) logs.splice(0, logs.length - CFG.logMax);
        state = { ...state, logs };
        console.log('[GLM] ' + msg);
        appendLogDOM(entry);
    }

    function extractHeaders(h) {
        const o = {};
        if (!h) return o;
        if (h instanceof Headers) h.forEach((v, k) => (o[k] = v));
        else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k] = v));
        else Object.entries(h).forEach(([k, v]) => (o[k] = v));
        return o;
    }

    // ═══════════════════════════════════════════
    //  自动参数捕获 — 触发真实购买按钮，让拦截器捕获真实请求
    // ═══════════════════════════════════════════
    let _autoCaptureAttempts = 0;

    function autoCaptureParams() {
        if (!CFG.autoCapture || state.captured) {
            if (state.captured) log('已有捕获的参数, 跳过自动捕获');
            return;
        }

        if (++_autoCaptureAttempts > 60) {
            log('⚠️ 自动捕获超时 (60次), 请刷新页面重试', 'error');
            return;
        }

        const app = document.querySelector('#app');
        if (!app) {
            setTimeout(autoCaptureParams, 2000);
            return;
        }

        log('尝试触发真实购买按钮以捕获请求... (第' + _autoCaptureAttempts + '次)');

        // 策略A: 在 DOM 中找 Max 套餐卡片内的购买按钮
        // 按钮通常包含文字 "立即购买" / "特惠购买" / "升级"
        let clicked = false;

        // 先找所有卡片容器，识别 Max 卡片
        const cards = document.querySelectorAll('[class*="card"], [class*="plan"], [class*="tier"], [class*="product"]');
        for (const card of cards) {
            const text = card.textContent.toLowerCase();
            if (!text.includes('max') && !text.includes('469')) continue;

            // 在 Max 卡片内找按钮
            for (const btn of card.querySelectorAll('button, [role="button"]')) {
                const bt = btn.textContent.trim();
                if (/购买|抢购|下单|特惠|升级|订阅/.test(bt) && bt.length < 15) {
                    log('找到 Max 套餐按钮: ' + bt + ', 尝试触发...');
                    forceClickButton(btn);
                    clicked = true;
                    break;
                }
            }
            if (clicked) break;
        }

        // 策略B: 通用查找所有购买按钮，找文字含 "Max" 或 "469" 的上级
        if (!clicked) {
            for (const btn of document.querySelectorAll('button, [role="button"]')) {
                const bt = btn.textContent.trim();
                if (!/购买|抢购|下单|特惠|升级|订阅/.test(bt) || bt.length >= 15) continue;

                // 检查按钮的父级是否在 Max 区域
                let p = btn.parentElement;
                for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
                    const t = p.textContent.toLowerCase();
                    if (t.includes('max') || t.includes('469')) {
                        log('找到 Max 区域按钮: ' + bt + ', 尝试触发...');
                        forceClickButton(btn);
                        clicked = true;
                        break;
                    }
                }
                if (clicked) break;
            }
        }

        // 策略C: Vue 组件方法直调
        if (!clicked) {
            log('DOM 按钮不可用, 尝试 Vue 组件方法...');
            tryVueDirectBuy();
        }
    }

    // 强制点击：绕过 Vue disabled 状态
    function forceClickButton(btn) {
        // 先解除 HTML disabled 属性
        btn.disabled = false;
        btn.classList.remove('disabled', 'is-disabled', 'el-button--disabled');
        btn.removeAttribute('disabled');

        // 通过 __vue__ 解除 Vue 组件级别的 disabled
        let vm = btn.__vue__;
        if (vm) {
            // 尝试各种可能的 disabled 字段名
            for (const key of ['disabled', 'isDisabled', 'btnDisabled', '_disabled']) {
                if (key in vm) {
                    try { vm[key] = false; } catch {}
                }
                if (vm.$data && key in vm.$data) {
                    try { vm.$data[key] = false; } catch {}
                }
            }
            // 也尝试 Vue 3 的 props
            if (vm.$props) {
                for (const key of ['disabled', 'isDisabled']) {
                    if (key in vm.$props) {
                        try { vm.$props[key] = false; } catch {}
                    }
                }
            }
            log('已尝试解除 Vue 组件级别 disabled');
        }

        // 点击
        log('点击按钮: ' + (btn.textContent || '').trim());
        btn.click();

        // 点击后检查是否捕获到了
        setTimeout(() => {
            if (state.captured) {
                log('✅ 成功通过按钮触发捕获到真实请求!');
                autoScheduleIfNeeded();
            } else {
                log('⚠️ 按钮点击后未捕获到请求, 可能是按钮仍被禁用或拦截器未触发');
                log('提示: 如果所有套餐均售罄，按钮可能跳转到其他页面而非发 API 请求');
                // 回退：用已知 productId 构建参数，但通过 fetch 拦截器发送
                fallbackCapture();
            }
        }, 3000);
    }

    // Vue 组件方法直调
    function tryVueDirectBuy() {
        const app = document.querySelector('#app');
        if (!app || !app.__vue__) {
            log('未找到 Vue 实例, 稍后重试...', 'warn');
            setTimeout(autoCaptureParams, 2000);
            return;
        }

        function findPayComponent(vm, depth) {
            if (depth > 15) return null;
            // 寻找有 selectPayTypeFn 或 buyFn 方法的组件
            if (vm.selectPayTypeFn || vm.getPayStatusFn || vm.buyFn || vm.handleBuy) {
                return vm;
            }
            for (const c of (vm.$children || [])) {
                const found = findPayComponent(c, depth + 1);
                if (found) return found;
            }
            return null;
        }

        const payComp = findPayComponent(app.__vue__, 0);
        if (payComp) {
            log('找到 PayComponent, 尝试直调购买方法...');
            const methods = Object.keys(payComp).filter(k => typeof payComp[k] === 'function');
            log('可用方法: ' + methods.filter(m => /pay|buy|select|order/i.test(m)).join(', '));

            // 尝试调用 selectPayTypeFn 传入 Max productId
            const maxId = CFG.productIdOverride || 'product-2fc421';
            if (typeof payComp.selectPayTypeFn === 'function') {
                try {
                    payComp.selectPayTypeFn(maxId);
                    log('已调用 selectPayTypeFn(' + maxId + ')');
                } catch (e) {
                    log('selectPayTypeFn 调用失败: ' + e.message, 'warn');
                }
            }

            setTimeout(() => {
                if (state.captured) {
                    log('✅ Vue 直调成功捕获到真实请求!');
                    autoScheduleIfNeeded();
                } else {
                    log('Vue 直调未触发 API 请求, 使用回退方案...');
                    fallbackCapture();
                }
            }, 3000);
        } else {
            log('未找到 PayComponent, 使用回退方案...');
            fallbackCapture();
        }
    }

    // 回退方案：用已知 productId，通过真实 fetch 发送一次请求来触发拦截器
    function fallbackCapture() {
        const maxId = CFG.productIdOverride || 'product-2fc421';
        log('回退: 通过浏览器原生 fetch 发送请求 ' + maxId);

        // 不自己构建参数，而是调用原始 fetch 发真实请求
        // 这样浏览器会自动带上 cookies、headers 等
        const body = JSON.stringify({ productId: maxId, quantity: 1, source: 'web' });
        const url = location.origin + CFG.PREVIEW;

        // 用被劫持的 window.fetch 发送（会走到拦截器）
        window.fetch(url, {
            method: 'POST',
            body: body,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
        }).then(resp => {
            log('fetch 响应: ' + resp.status);
            if (!state.captured) {
                // 拦截器没捕获到，手动设置回退参数
                log('拦截器未触发, 手动设置捕获参数');
                const token = getAuthToken();
                const hdrs = { 'Content-Type': 'application/json' };
                if (token) hdrs['Authorization'] = 'Bearer ' + token;
                const captured = {
                    url: url,
                    method: 'POST',
                    body: body,
                    headers: hdrs,
                    productId: maxId,
                    productName: 'Max',
                };
                setState({ captured });
                try { sessionStorage.setItem('glm_rush_plus_captured', JSON.stringify(captured)); } catch {}
                autoScheduleIfNeeded();
            }
        }).catch(err => {
            log('fetch 失败: ' + err.message, 'warn');
        });
    }

    // ═══════════════════════════════════════════
    //  JSON.parse 定向拦截
    // ═══════════════════════════════════════════
    const _parse = JSON.parse;

    function patchSoldOut(obj, visited = new WeakSet()) {
        if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
        visited.add(obj);
        if (obj.isSoldOut === true) obj.isSoldOut = false;
        if (obj.soldOut === true) obj.soldOut = false;
        if (obj.isServerBusy === true) obj.isServerBusy = false;
        if (obj.disabled === true && (obj.price !== undefined || obj.productId || obj.title)) obj.disabled = false;
        if (obj.stock === 0) obj.stock = 999;
        for (const k of Object.keys(obj)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (obj[k] && typeof obj[k] === 'object') patchSoldOut(obj[k], visited);
        }
    }

    JSON.parse = function (text, reviver) {
        const result = _parse(text, reviver);
        try { patchSoldOut(result); } catch {}
        return result;
    };
    Object.defineProperty(JSON.parse, 'toString', { value: () => 'function parse() { [native code] }' });

    // ═══════════════════════════════════════════
    //  核心: 并发重试引擎
    // ═══════════════════════════════════════════
    const _fetch = window.fetch;
    let _retryLock = null;

    // 从页面提取 auth token（多来源回退）
    function getAuthToken() {
        // 1. 已捕获的 headers 中提取
        if (state.captured && state.captured.headers) {
            const h = state.captured.headers;
            if (h['Authorization']) return h['Authorization'].replace('Bearer ', '');
            if (h['authorization']) return h['authorization'].replace('Bearer ', '');
        }
        // 2. 从 localStorage 提取 (Coding Plan 页面用户数据)
        try {
            const keys = ['user', 'currentUser', 'userInfo', 'token', 'accessToken', 'access_token', 'auth'];
            for (const k of keys) {
                const raw = localStorage.getItem(k);
                if (!raw) continue;
                try {
                    const j = JSON.parse(raw);
                    const t = j.token || j.accessToken || j.access_token || j.jwt || j.authorization;
                    if (t && t.length > 20) return t.replace('Bearer ', '');
                } catch {
                    if (raw.length > 30 && raw.length < 500) return raw.replace('Bearer ', '');
                }
            }
        } catch {}
        // 3. 从 cookie 提取
        try {
            const cookies = document.cookie.split(';');
            for (const c of cookies) {
                const [k, v] = c.trim().split('=');
                if (!k || !v) continue;
                if (/token|auth|jwt|session|passport/i.test(k) && v.length > 20) return v;
            }
        } catch {}
        // 4. 从 Vuex Store 提取
        try {
            const app = document.querySelector('#app');
            if (app && app.__vue__) {
                let found = null;
                function dig(vm, d) {
                    if (d > 12 || found) return;
                    const store = vm.$store || vm.store;
                    if (store && store.state) {
                        for (const mod of ['User', 'Login', 'Auth', 'user', 'login', 'auth']) {
                            const m = store.state[mod];
                            if (!m) continue;
                            for (const key of Object.keys(m)) {
                                const v = m[key];
                                if (typeof v === 'string' && v.length > 30) { found = v.replace('Bearer ', ''); return; }
                            }
                        }
                    }
                    for (const c of (vm.$children || [])) dig(c, d + 1);
                }
                dig(app.__vue__, 0);
                if (found) return found;
            }
        } catch {}
        return '';
    }

    // 从捕获的 headers 中补全智谱自定义 headers（页面 HTTP client 自动加的）
    function enrichHeaders(headers) {
        const h = { ...headers };
        // 1. authorization/Authorization 统一处理
        const authVal = h['authorization'] || h['Authorization'] || '';
        if (authVal) {
            // 确保两种写法都有
            h['Authorization'] = authVal.startsWith('Bearer ') ? authVal : 'Bearer ' + authVal;
            h['authorization'] = h['Authorization'];
        }
        // 2. 补全智谱自定义 headers（从捕获的 headers 里取，没捕获到就从 cookie 里解析）
        const CUSTOM_KEYS = ['bigmodel-organization', 'bigmodel-project', 'bigmodel-customer', 'bigmodel-user'];
        for (const k of CUSTOM_KEYS) {
            if (!h[k] && !h[k.toLowerCase()]) {
                // 尝试从捕获的 headers 里找（大小写不敏感）
                const found = Object.entries(h).find(([kk]) => kk.toLowerCase() === k.toLowerCase());
                if (found) h[k] = found[1];
            }
        }
        // 3. 确保 credentials 相关的 cookie 会被发送（credentials: 'include' 在 fetch 参数里）
        return h;
    }

    async function singleAttempt(url, opts, attemptNum) {
        try {
            // 用捕获的完整 headers 作为基础，再补随机头
            const baseHeaders = enrichHeaders(opts.headers || {});
            const authToken = getAuthToken();
            const randHeaders = { ...baseHeaders };
            if (authToken && !randHeaders['Authorization'] && !randHeaders['authorization']) {
                randHeaders['Authorization'] = 'Bearer ' + authToken;
                randHeaders['authorization'] = randHeaders['Authorization'];
            }
            // 补智谱自定义 headers（如果捕获时没拿到，尝试从 cookie 解析）
            if (!randHeaders['bigmodel-organization']) {
                const m = document.cookie.match(/bigmodel_organization=([^;]+)/);
                if (m) randHeaders['bigmodel-organization'] = decodeURIComponent(m[1]);
            }
            if (!randHeaders['bigmodel-project']) {
                const m = document.cookie.match(/bigmodel_project=([^;]+)/);
                if (m) randHeaders['bigmodel-project'] = decodeURIComponent(m[1]);
            }
            randHeaders['X-Request-Id'] = Math.random().toString(36).slice(2, 15);
            randHeaders['X-Timestamp'] = String(Date.now());
            const q = (0.5 + Math.random() * 0.5).toFixed(1);
            randHeaders['Accept-Language'] = 'zh-CN,zh;q=' + q + ',en;q=' + (q * 0.7).toFixed(1);

            const resp = await _fetch(url, { ...opts, headers: randHeaders, credentials: 'include' });

            if (resp.status === 401 || resp.status === 403) {
                return { ok: false, reason: 'HTTP ' + resp.status + ' 会话过期', attempt: attemptNum };
            }
            if (resp.status === 405) {
                // WAF 封禁 — 立即停止全部重试
                log('WAF 封禁! (405), 立即停止避免 IP 被封', 'error');
                stopRequested = true;
                return { ok: false, reason: 'WAF封禁(405)', attempt: attemptNum };
            }
            if (resp.status === 429) {
                return { ok: false, reason: '429 限流', attempt: attemptNum };
            }

            const text = await resp.text();
            let data;
            try { data = _parse(text); } catch { data = null; }

            if (data && data.code === 200 && data.data && data.data.bizId) {
                const bizId = data.data.bizId;

                // check 校验
                try {
                    const checkUrl = location.origin + CFG.CHECK + '?bizId=' + encodeURIComponent(bizId);
                    const checkResp = await _fetch(checkUrl, { credentials: 'include' });
                    const checkText = await checkResp.text();
                    let checkData;
                    try { checkData = _parse(checkText); } catch { checkData = null; }

                    if (checkData && checkData.data === 'EXPIRE') {
                        return { ok: false, reason: 'EXPIRE', attempt: attemptNum };
                    }

                    return { ok: true, text, data, bizId, status: resp.status, attempt: attemptNum };
                } catch (e) {
                    return { ok: false, reason: 'check异常: ' + e.message, attempt: attemptNum };
                }
            }

            const reason = !data ? '非JSON'
                : data.code === 1001 ? '缺少Auth(1001)'
                : data.code === 555 ? '系统繁忙'
                : (data.data && data.data.bizId === null) ? '售罄'
                : 'code=' + data.code;
            return { ok: false, reason, attempt: attemptNum };
        } catch (e) {
            if (e.name === 'AbortError') return { ok: false, reason: '已取消', attempt: attemptNum };
            return { ok: false, reason: '网络: ' + e.message, attempt: attemptNum };
        }
    }

    async function retry(url, rawOpts) {
        if (_retryLock) {
            log('合并到当前重试...');
            return _retryLock;
        }

        stopRequested = false;
        const { signal, ...opts } = rawOpts || {};

        _retryLock = (async () => {
            setState({ status: 'retrying', count: 0, stats: { ...state.stats, startTime: performance.now() } });

            let totalAttempt = 0;
            let consecutiveErrors = 0;
            let throttleCount = 0;
            let consecutiveSoldOut = 0;

            while (totalAttempt < CFG.maxRetry && !stopRequested) {
                const elapsedMs = performance.now() - state.stats.startTime;
                const isTurbo = elapsedMs < CFG.turboSec * 1000;
                const curConcurrency = isTurbo ? CFG.turboConcurrency : CFG.concurrency;
                const batchSize = Math.min(curConcurrency, CFG.maxRetry - totalAttempt);
                const controllers = [];
                const promises = [];

                for (let j = 0; j < batchSize; j++) {
                    totalAttempt++;
                    const ac = new AbortController();
                    controllers.push(ac);
                    promises.push(singleAttempt(url, { ...opts, headers: state.captured?.headers || opts.headers, signal: ac.signal }, totalAttempt));
                }

                setState({ count: totalAttempt });

                const winner = await new Promise(resolve => {
                    let settled = false;
                    let doneCount = 0;
                    promises.forEach((p, idx) => {
                        p.then(r => {
                            if (r.ok && !settled) {
                                settled = true;
                                controllers.forEach((ac, i) => { if (i !== idx) try { ac.abort(); } catch {} });
                                resolve(r);
                            }
                            if (++doneCount === promises.length && !settled) resolve(null);
                        });
                    });
                });

                const results = await Promise.all(promises.map(p => p.catch(() => ({ ok: false, reason: '已取消' }))));

                if (winner) {
                    setState({
                        status: 'success',
                        bizId: winner.bizId,
                        lastSuccess: { text: winner.text, data: winner.data },
                        stats: { ...state.stats, total: totalAttempt, success: state.stats.success + 1 },
                    });
                    log('成功! bizId=' + winner.bizId + ' (第' + winner.attempt + '次)');
                    recoveryAttempts = 0;
                    setTimeout(autoRecover, 500);
                    return { ok: true, text: winner.text, data: winner.data, status: winner.status };
                }

                const failedResults = results.filter(r => !r.ok);
                const reasons = failedResults.map(r => r.reason || '未知');
                setState({ stats: { ...state.stats, errors: state.stats.errors + failedResults.length } });

                const networkErrors = reasons.filter(r => r.startsWith('网络')).length;
                consecutiveErrors = networkErrors === batchSize ? consecutiveErrors + 1 : 0;

                if (consecutiveErrors >= 3) {
                    log('网络异常, 暂停3秒...');
                    await sleep(3000);
                    consecutiveErrors = 0;
                }

                // 连续 1001 (缺少Authorization) → 立即停止
                if (reasons.filter(r => r === '缺少Auth(1001)').length === batchSize && totalAttempt >= 10) {
                    log('连续缺少Authorization, 可能token失效, 停止重试', 'error');
                    setState({ status: 'failed' });
                    return { ok: false };
                }

                if (reasons.some(r => r.includes('会话过期'))) {
                    log('会话已过期, 请重新登录!', 'error');
                    setState({ status: 'failed' });
                    return { ok: false };
                }

                if (reasons.some(r => r.includes('429') || r.includes('限流'))) {
                    throttleCount++;
                    const backoff = Math.min(2000 * (2 ** Math.min(throttleCount, 4)), 16000);
                    log('限流, 退避' + backoff + 'ms...', 'warn');
                    await sleep(backoff);
                } else {
                    throttleCount = 0;
                }

                if (reasons.every(r => r === 'EXPIRE')) continue;

                const elapsedSec = (performance.now() - state.stats.startTime) / 1000;

                if (elapsedSec > 20) {
                    const soldOutCount = reasons.filter(r => r === '售罄').length;
                    if (soldOutCount === batchSize) consecutiveSoldOut++;
                    else consecutiveSoldOut = 0;
                    if (consecutiveSoldOut >= 10) {
                        if (consecutiveSoldOut === 10) log('连续售罄, 可能已抢完, 降速 (2s)...');
                        await sleep(2000);
                        continue;
                    }
                }

                if (totalAttempt <= 5 * CFG.concurrency || totalAttempt % (20 * CFG.concurrency) === 0) {
                    const sec = elapsedSec.toFixed(0);
                    log('#' + totalAttempt + ' ' + reasons[0] + ' (' + sec + 's)');
                }

                const d = getDelay(totalAttempt / CFG.concurrency);
                if (d > 0) await sleep(d);
            }

            if (!stopRequested) {
                setState({ status: 'failed' });
                log('达到上限 ' + CFG.maxRetry + ' 次');
            } else {
                setState({ status: 'idle' });
            }
            return { ok: false };
        })();

        try { return await _retryLock; }
        finally { _retryLock = null; }
    }

    // ═══════════════════════════════════════════
    //  Fetch 拦截
    // ═══════════════════════════════════════════
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input?.url;

        if (url && url.includes(CFG.PREVIEW)) {
            // 捕获请求参数
            const captured = {
                url,
                method: init?.method || 'POST',
                body: init?.body,
                headers: extractHeaders(init?.headers),
            };
            setState({ captured });
            try { sessionStorage.setItem('glm_rush_plus_captured', JSON.stringify(captured)); } catch {}

            if (state.status === 'success' && state.lastSuccess) {
                log('已抢到, 返回成功响应');
                return new Response(state.lastSuccess.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            if (state.cache) {
                log('返回缓存响应');
                const c = state.cache;
                setState({ cache: null });
                recoveryAttempts = 0;
                return new Response(c.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            if (state.proactive || state.status === 'retrying') {
                log('抢购中, 启动重试...');
                const result = await retry(url, {
                    method: init?.method || 'POST',
                    body: init?.body,
                    headers: extractHeaders(init?.headers),
                });
                if (result.ok) {
                    return new Response(result.text, { status: result.status, headers: { 'Content-Type': 'application/json' } });
                }
                return _fetch.apply(this, [input, init]);
            }

            log('已捕获请求参数, 设定定时...');
            autoScheduleIfNeeded();
            return _fetch.apply(this, [input, init]);
        }

        if (url && url.includes(CFG.CHECK) && url.includes('bizId=null')) {
            log('拦截 check(bizId=null)');
            return new Response('{"code":-1,"msg":"等待有效bizId"}', {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }

        return _fetch.apply(this, [input, init]);
    };
    window.fetch.toString = () => 'function fetch() { [native code] }';

    // ═══════════════════════════════════════════
    //  XHR 拦截
    // ═══════════════════════════════════════════
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;
    const _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        (this._h || (this._h = {}))[k] = v;
        return _xhrSetHeader.call(this, k, v);
    };
    XMLHttpRequest.prototype.open = function (method, url) {
        this._m = method; this._u = url;
        return _xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const url = this._u;

        if (typeof url === 'string' && url.includes(CFG.PREVIEW)) {
            const self = this;
            const captured = { url, method: this._m, body, headers: this._h || {} };
            setState({ captured });
            try { sessionStorage.setItem('glm_rush_plus_captured', JSON.stringify(captured)); } catch {}

            if (state.status === 'success' && state.lastSuccess) {
                log('已抢到, 返回成功响应 (XHR)');
                fakeXHR(self, state.lastSuccess.text);
                return;
            }

            if (state.cache) {
                log('返回缓存响应 (XHR)');
                const c = state.cache; setState({ cache: null });
                recoveryAttempts = 0;
                fakeXHR(self, c.text);
                return;
            }

            if (state.proactive || state.status === 'retrying') {
                log('抢购中, 启动重试 (XHR)...');
                retry(url, { method: this._m, body, headers: this._h || {} }).then(result => {
                    fakeXHR(self, result.ok ? result.text : '{"code":-1,"msg":"重试失败"}');
                });
                return;
            }

            log('已捕获请求参数, 设定定时...');
            autoScheduleIfNeeded();
            return _xhrSend.call(this, body);
        }

        if (typeof url === 'string' && url.includes(CFG.CHECK) && url.includes('bizId=null')) {
            fakeXHR(this, '{"code":-1,"msg":"等待有效bizId"}');
            return;
        }

        return _xhrSend.call(this, body);
    };

    function fakeXHR(xhr, text) {
        setTimeout(() => {
            const dp = (k, v) => Object.defineProperty(xhr, k, { value: v, configurable: true });
            dp('readyState', 4); dp('status', 200); dp('statusText', 'OK');
            dp('responseText', text); dp('response', text);
            const ev = new Event('readystatechange');
            if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange(ev);
            xhr.dispatchEvent(ev);
            const ld = new ProgressEvent('load');
            if (typeof xhr.onload === 'function') xhr.onload(ld);
            xhr.dispatchEvent(ld);
            xhr.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
    }

    // ═══════════════════════════════════════════
    //  弹窗恢复
    // ═══════════════════════════════════════════
    function findErrorDialog() {
        const sels = [
            '.el-dialog', '.el-message-box', '.el-dialog__wrapper',
            '.ant-modal', '.ant-modal-wrap',
            '[class*="modal"]', '[class*="dialog"]', '[class*="popup"]', '[role="dialog"]',
        ];
        for (const sel of sels) {
            for (const el of document.querySelectorAll(sel)) {
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
                if (!el.offsetParent && s.position !== 'fixed') continue;
                if (/购买人数过多|系统繁忙|稍后再试|请重试|繁忙|失败|出错|异常/.test(el.textContent || '')) return el;
            }
        }
        return null;
    }

    function dismissDialog(dialog) {
        for (const sel of ['.el-dialog__headerbtn', '.el-message-box__headerbtn', '.ant-modal-close', '[aria-label="Close"]', '[aria-label="close"]']) {
            const btn = dialog.querySelector(sel);
            if (btn && btn.offsetParent !== null) { btn.click(); return true; }
        }
        for (const btn of dialog.querySelectorAll('button, [role="button"]')) {
            const t = (btn.textContent || '').trim();
            if (/关闭|确定|取消|知道了|OK|Cancel|Close|确认/.test(t) && t.length < 10) { btn.click(); return true; }
        }
        dialog.style.display = 'none';
        return true;
    }

    async function autoRecover() {
        if (recovering || recoveryAttempts >= CFG.recoveryMax || !state.lastSuccess) return;

        const payEl = document.querySelector('[class*="pay"], [class*="qrcode"], [class*="wechat"], [class*="alipay"], [class*="cashier"], iframe[src*="pay"]');
        if (payEl && (payEl.offsetParent !== null || window.getComputedStyle(payEl).position === 'fixed')) {
            log('支付弹窗已出现, 跳过恢复');
            return;
        }

        const dialog = findErrorDialog();
        if (!dialog) return;

        recovering = true;
        recoveryAttempts++;
        try {
            log('检测到错误弹窗, 清理中...');
            dismissDialog(dialog);
            await sleep(300);

            setState({ cache: state.lastSuccess });
            const btn = findBuyButton();
            if (btn) {
                btn.click();
                log('已重新点击购买按钮 (策略2)');
                await sleep(2000);
            }

            const payDialog = document.querySelector('[class*="pay"], [class*="qrcode"], [class*="wechat"], [class*="alipay"]');
            if (!payDialog || payDialog.offsetParent === null) {
                const bizId = state.bizId;
                if (bizId) {
                    log('支付弹窗未出现, 尝试直接调用 check 页面...');
                    try {
                        const checkUrl = location.origin + CFG.CHECK + '?bizId=' + encodeURIComponent(bizId);
                        const resp = await _fetch(checkUrl, { credentials: 'include' });
                        const data = await resp.json();
                        log('check响应: ' + JSON.stringify(data).substring(0, 200));

                        if (data.data && typeof data.data === 'string' && data.data.startsWith('http')) {
                            log('获取到支付链接, 跳转中...');
                            window.open(data.data, '_blank');
                        } else if (data.data && data.data.payUrl) {
                            log('获取到payUrl, 跳转中...');
                            window.open(data.data.payUrl, '_blank');
                        } else if (data.data && data.data.qrCode) {
                            log('获取到二维码数据');
                            showQRCodeFallback(data.data.qrCode, bizId);
                        }
                    } catch (e) { log('check调用失败: ' + e.message); }
                }
            } else {
                log('支付弹窗已出现!');
            }
        } finally { recovering = false; }
    }

    function showQRCodeFallback(qrData, bizId) {
        const div = document.createElement('div');
        div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;background:#fff;padding:30px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);text-align:center';
        div.innerHTML = '<h3 style="margin:0 0 15px;color:#333">扫码支付</h3><img src="' + qrData + '" style="width:200px;height:200px" onerror="this.parentElement.innerHTML+=\'<p>二维码加载失败</p>\'"><p style="margin:15px 0 0;color:#666;font-size:13px">bizId: ' + bizId + '</p><button onclick="this.parentElement.remove()" style="margin-top:10px;padding:6px 20px;border:1px solid #ddd;border-radius:4px;cursor:pointer">关闭</button>';
        document.body.appendChild(div);
        log('已显示兜底支付二维码');
    }

    function setupDialogWatcher() {
        const observer = new MutationObserver(() => {
            if (state.lastSuccess && !recovering && recoveryAttempts < CFG.recoveryMax) {
                const d = findErrorDialog();
                if (d) autoRecover();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ═══════════════════════════════════════════
    //  主动抢购 & 定时
    // ═══════════════════════════════════════════
    function findBuyButton() {
        for (const el of document.querySelectorAll('button.buy-btn')) {
            if (el.offsetParent !== null) return el;
        }
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            const t = el.textContent.trim();
            if (/购买|抢购|下单|特惠/.test(t) && t.length < 15 && el.offsetParent !== null) return el;
        }
        return null;
    }

    async function startProactive() {
        if (!state.captured) {
            log('无捕获参数, 尝试自动捕获...');
            autoCaptureParams();
            await sleep(2000);
            if (!state.captured) {
                log('自动捕获失败, 请检查登录状态');
                alert('未捕获到请求参数!\n\n请确认已登录 bigmodel.cn\n或在面板中设置 productIdOverride');
                return;
            }
        }
        if (state.status === 'success') {
            log('已经抢到了, 不重复抢购');
            return;
        }
        setState({ proactive: true });
        log('极速抢购启动! 前' + CFG.turboSec + '秒' + CFG.turboConcurrency + '路并发, 之后' + CFG.concurrency + '路');

        const { url, method, body } = state.captured;
        const result = await retry(url, { method, body, headers: state.captured?.headers || {} });
        setState({ proactive: false });

        if (result.ok) {
            setState({ cache: { text: result.text, data: result.data } });
            log('抢购成功! 触发支付...');
            if ('Notification' in window && Notification.permission === 'granted') {
                try { new Notification('GLM 抢购成功!', { body: 'bizId=' + state.bizId, requireInteraction: true }); } catch {}
            }
            const errDlg = findErrorDialog();
            if (errDlg) { dismissDialog(errDlg); await sleep(300); }
            const btn = findBuyButton();
            if (btn) { btn.click(); log('已自动点击购买按钮'); }
            else { alert('已获取到商品! 请立即点击购买按钮!'); }
            await sleep(1500);
            forcePayDialog(result.data);
        }
    }

    function stopAll() {
        stopRequested = true;
        setState({ proactive: false, status: 'idle', count: 0 });
        if (state.timerId) { clearInterval(state.timerId); setState({ timerId: null }); }
        log('已停止');
    }

    // ═══════════════════════════════════════════
    //  北京时间同步 + 自动定时
    // ═══════════════════════════════════════════
    let serverTimeOffset = 0;

    async function syncServerTime() {
        try {
            const t0 = Date.now();
            const resp = await _fetch(location.origin + '/api/biz/pay/check?bizId=sync', { credentials: 'include' }).catch(() => null);
            const t1 = Date.now();
            const rtt = t1 - t0;

            if (resp && resp.headers.get('date')) {
                const serverTime = new Date(resp.headers.get('date')).getTime();
                serverTimeOffset = serverTime - (t0 + rtt / 2);
                log('时间同步: 偏差 ' + (serverTimeOffset > 0 ? '+' : '') + serverTimeOffset + 'ms');
                return;
            }
        } catch {}

        try {
            const resp = await fetch('https://worldtimeapi.org/api/timezone/Asia/Shanghai');
            const data = await resp.json();
            serverTimeOffset = new Date(data.datetime).getTime() - Date.now();
            log('时间同步(备用): 偏差 ' + (serverTimeOffset > 0 ? '+' : '') + serverTimeOffset + 'ms');
        } catch {
            log('时间同步失败, 使用本地时钟');
        }
    }

    function getServerNow() {
        return Date.now() + serverTimeOffset;
    }

    function autoScheduleIfNeeded() {
        if (state.timerId || state.status === 'retrying' || state.status === 'success') return;

        const parts = CFG.rushTime.split(':').map(Number);
        const now = new Date(getServerNow());
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts[0], parts[1], parts[2] || 0);

        if (target.getTime() <= getServerNow()) {
            const passedSec = (getServerNow() - target.getTime()) / 1000;
            if (passedSec < 30) {
                log('已过' + CFG.rushTime + ' ' + passedSec.toFixed(0) + '秒, 立即开抢!');
                startProactive();
            } else {
                log('今天' + CFG.rushTime + '已过, 明天自动抢购');
            }
            return;
        }

        scheduleAt(CFG.rushTime);
        log('已自动设定 ' + CFG.rushTime + ' 抢购');
    }

    function scheduleAt(timeStr) {
        if (state.timerId) { clearInterval(state.timerId); setState({ timerId: null }); }
        const parts = timeStr.split(':').map(Number);
        if (parts.length < 2 || parts[0] > 23 || parts[1] > 59) { log('时间格式错误'); return; }

        const now = new Date(getServerNow());
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts[0], parts[1], parts[2] || 0);
        if (target.getTime() <= getServerNow()) { log('目标时间已过'); return; }

        const ms = target.getTime() - getServerNow();
        log('定时: ' + timeStr + ' (' + Math.ceil(ms / 1000) + '秒后)');

        if (ms > 4000) {
            setTimeout(() => {
                log('定时前3秒, 自动预热...');
                preheat();
            }, Math.max(0, ms - 3000));
        }

        const tid = setInterval(() => {
            const remaining = target.getTime() - getServerNow();
            if (remaining > 0 && remaining < 60000) {
                const timerEl = _shadowRef?.getElementById('timer-info');
                if (timerEl) timerEl.textContent = '-' + (remaining / 1000).toFixed(1) + 's';
            }
            if (remaining <= 0) {
                clearInterval(tid);
                setState({ timerId: null });
                const timerEl = _shadowRef?.getElementById('timer-info');
                if (timerEl) timerEl.textContent = '';
                log('时间到! 自动启动抢购!');
                startProactive();
            }
        }, 10);

        setState({ timerId: tid });
    }

    async function preheat() {
        try {
            log('TCP预热中...');
            for (let i = 0; i < 3; i++) {
                await _fetch(location.origin + '/api/biz/pay/check?bizId=preheat_' + i, { credentials: 'include' }).catch(() => {});
                await sleep(200);
            }
            await _fetch(location.origin + CFG.PREVIEW, { method: 'HEAD', credentials: 'include' }).catch(() => {});
            log('预热完成');
        } catch { log('预热部分失败，不影响使用'); }
    }

    // ═══════════════════════════════════════════
    //  快捷键
    // ═══════════════════════════════════════════
    document.addEventListener('keydown', e => {
        if (!e.altKey) return;
        if (e.key === 's' || e.key === 'S') { e.preventDefault(); startProactive(); }
        if (e.key === 'x' || e.key === 'X') { e.preventDefault(); stopAll(); }
        if (e.key === 'h' || e.key === 'H') {
            e.preventDefault();
            if (_shadowRef) {
                const bd = _shadowRef.getElementById('bd');
                if (bd) bd.style.display = bd.style.display === 'none' ? '' : 'none';
            }
        }
    });

    // ═══════════════════════════════════════════
    //  Vue isServerBusy 兜底 patch
    // ═══════════════════════════════════════════
    function patchVueServerBusy() {
        let attempts = 0;
        const tid = setInterval(() => {
            attempts++;
            if (attempts > 30) { clearInterval(tid); return; }
            const app = document.querySelector('#app');
            const vue = app && app.__vue__;
            if (!vue) return;
            let patched = 0;
            const walk = (vm, depth) => {
                if (depth > 8) return;
                if (vm.$data && vm.$data.isServerBusy === true) {
                    vm.isServerBusy = false;
                    patched++;
                }
                for (const child of (vm.$children || [])) walk(child, depth + 1);
            };
            walk(vue, 0);
            if (patched > 0) {
                log('已解除 isServerBusy (' + patched + '个组件)');
                clearInterval(tid);
            }
        }, 500);
    }

    function forcePayDialog(responseData) {
        const app = document.querySelector('#app');
        const vue = app && app.__vue__;
        if (!vue) return;

        let payComp = null;
        const findComp = (vm, depth) => {
            if (depth > 8) return;
            if (vm.$data && 'payDialogVisible' in vm.$data) { payComp = vm; return; }
            for (const child of (vm.$children || [])) { findComp(child, depth + 1); if (payComp) return; }
        };
        findComp(vue, 0);
        if (!payComp) { log('未找到支付组件'); return; }
        if (payComp.payDialogVisible) { log('支付弹窗已显示'); return; }

        const data = responseData && responseData.data;
        if (data) {
            payComp.priceData = data;
            payComp.payDialogVisible = true;
            log('兜底: 已直接设置 payDialogVisible=true');
        }
    }

    // ═══════════════════════════════════════════
    //  浮动面板 (Shadow DOM)
    // ═══════════════════════════════════════════
    function createPanel() {
        const host = document.createElement('div');
        host.id = 'glm-rush-host';
        const shadow = host.attachShadow({ mode: 'closed' });

        shadow.innerHTML = `
<style>
:host{all:initial;position:fixed;top:10px;right:10px;z-index:999999;font-family:Consolas,'Courier New',monospace}
*{box-sizing:border-box;margin:0;padding:0}
.panel{width:360px;background:#1a1a2e;color:#e0e0e0;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);font-size:13px;line-height:1.5;user-select:none}
.hd{background:linear-gradient(135deg,#0f3460,#16213e);padding:9px 14px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:move}
.hd b{font-size:14px;letter-spacing:.5px}
.mn{background:none;border:none;color:#aaa;cursor:pointer;font-size:20px;line-height:1;padding:0 4px}
.mn:hover{color:#fff}
.bd{padding:12px 14px 14px}
.st{padding:8px;border-radius:8px;text-align:center;font-weight:700;margin-bottom:10px;transition:background .3s}
.st-idle{background:#2d3436}
.st-retrying{background:#e17055;animation:pulse 1s infinite}
.st-success{background:#00b894}
.st-failed{background:#d63031}
@keyframes pulse{50%{opacity:.7}}
.cap{font-size:11px;padding:5px 8px;background:#2d3436;border-radius:6px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;flex-wrap:wrap}
.row input[type=number],.row input[type=time]{width:60px;padding:4px 6px;border:1px solid #444;border-radius:4px;background:#2d3436;color:#fff;text-align:center;font-size:12px}
.btns{display:flex;gap:8px;margin-bottom:10px}
.btns button{flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;color:#fff;transition:opacity .2s}
.btns button:hover{opacity:.85}
.b-go{background:#0984e3}
.b-stop{background:#d63031}
.b-heat{background:#fdcb6e;color:#2d3436}
.b-capture{background:#00b894;flex:0 0 auto!important;padding:4px 10px!important}
.b-time{background:#6c5ce7;flex:0 0 auto!important;padding:4px 10px!important}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;font-size:11px;text-align:center}
.stats div{background:#2d3436;border-radius:4px;padding:4px}
.stats .v{font-size:16px;font-weight:700;color:#74b9ff}
.logs{max-height:180px;overflow-y:auto;background:#0d1117;border-radius:6px;padding:6px 8px;font-size:11px;line-height:1.7}
.logs div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.logs .ok{color:#00b894} .logs .warn{color:#fdcb6e} .logs .err{color:#d63031} .logs .info{color:#dfe6e9}
.logs::-webkit-scrollbar{width:4px}
.logs::-webkit-scrollbar-thumb{background:#444;border-radius:2px}
.keys{font-size:10px;color:#636e72;text-align:center;margin-top:6px}
</style>
<div class="panel">
  <div class="hd" id="drag"><b>GLM v5.0 AUTO</b><button class="mn" id="min">-</button></div>
  <div class="bd" id="bd">
    <div class="st st-idle" id="st">等待中 (自动捕获)</div>
    <div class="cap" id="cap">${state.captured ? '已捕获: ' + (state.captured.productId || '手动') : '页面加载后自动捕获...'}</div>
    <div class="stats">
      <div><div class="v" id="s-cnt">0</div>重试</div>
      <div><div class="v" id="s-ok">0</div>成功</div>
      <div><div class="v" id="s-err">0</div>错误</div>
    </div>
    <div class="row">
      <span>并发</span><input type="number" id="i-conc" value="${CFG.concurrency}" min="1" max="20" step="1">
      <span>极速</span><input type="number" id="i-turbo" value="${CFG.turboConcurrency}" min="1" max="20" step="1">
      <span>上限</span><input type="number" id="i-max" value="${CFG.maxRetry}" min="10" max="9999" step="50">
    </div>
    <div class="row">
      <span>定时</span><input type="time" id="i-time" step="1">
      <button class="b-time" id="b-time">设定</button>
      <span id="timer-info" style="color:#6c5ce7;font-size:11px"></span>
    </div>
    <div class="btns">
      <button class="b-go" id="b-go">▶ 主动抢购</button>
      <button class="b-stop" id="b-stop" style="display:none">■ 停止</button>
      <button class="b-heat" id="b-heat">预热</button>
      <button class="b-capture" id="b-capture" title="手动重新捕获参数">🔄</button>
    </div>
    <div class="logs" id="logs"></div>
    <div class="keys">Alt+S 抢购 | Alt+X 停止 | Alt+H 隐藏</div>
  </div>
</div>`;

        document.body.appendChild(host);

        const $ = id => shadow.getElementById(id);
        $('b-go').onclick = startProactive;
        $('b-stop').onclick = stopAll;
        $('b-heat').onclick = preheat;
        $('b-capture').onclick = () => { setState({ captured: null }); sessionStorage.removeItem('glm_rush_plus_captured'); autoCaptureParams(); };
        $('b-time').onclick = () => { const v = $('i-time').value; if (v) { CFG.rushTime = v; saveCfg(CFG); scheduleAt(v); } };
        $('i-conc').onchange = function() { CFG.concurrency = Math.max(1, +this.value || 5); saveCfg(CFG); };
        $('i-turbo').onchange = function() { CFG.turboConcurrency = Math.max(1, +this.value || 10); saveCfg(CFG); };
        $('i-max').onchange = function() { CFG.maxRetry = Math.max(10, +this.value || 2000); saveCfg(CFG); };
        $('min').onclick = function() {
            const bd = $('bd');
            const hidden = bd.style.display === 'none';
            bd.style.display = hidden ? '' : 'none';
            this.textContent = hidden ? '-' : '+';
        };

        // 拖拽
        let sx, sy, sl, st;
        $('drag').onmousedown = function(e) {
            sx = e.clientX; sy = e.clientY;
            const rect = host.getBoundingClientRect();
            sl = rect.left; st = rect.top;
            const onMove = e => { host.style.left = (sl + e.clientX - sx) + 'px'; host.style.top = (st + e.clientY - sy) + 'px'; host.style.right = 'auto'; host.style.position = 'fixed'; };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };

        _shadowRef = shadow;

        // 请求通知权限（抢购成功时需要弹窗提示）
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(p => {
                log('通知权限: ' + p);
            }).catch(() => {});
        }

        log('v5.0 已加载 (自动捕获 + 极速并发)');
        if (state.captured) log('已恢复上次捕获: ' + (state.captured.productName || state.captured.productId || '手动'));

        setupDialogWatcher();
        patchVueServerBusy();
        syncServerTime();

        // 核心: 自动捕获参数
        if (!state.captured) {
            log('等待页面就绪后自动捕获...');
            setTimeout(autoCaptureParams, 1500);
        }
    }

    // ═══════════════════════════════════════════
    //  UI 更新
    // ═══════════════════════════════════════════
    let uiPending = false;

    function refreshUI() {
        if (uiPending) return;
        uiPending = true;
        requestAnimationFrame(() => {
            uiPending = false;
            const shadow = _shadowRef;
            if (!shadow) return;
            const $ = id => shadow.getElementById(id);

            const stEl = $('st');
            if (stEl) {
                stEl.className = 'st st-' + state.status;
                const isTurbo = state.stats.startTime && (performance.now() - state.stats.startTime) < CFG.turboSec * 1000;
                stEl.textContent = state.status === 'idle' ? '等待中'
                    : state.status === 'retrying' ? (isTurbo ? '极速' : '') + '重试中... ' + state.count + '/' + CFG.maxRetry
                    : state.status === 'success' ? '成功! bizId=' + state.bizId
                    : '失败 (' + state.count + '次)';
            }

            const capEl = $('cap');
            if (capEl) {
                capEl.textContent = state.captured
                    ? '已捕获: ' + (state.captured.productName || 'Max') + ' → ' + (state.captured.productId || state.captured.url?.split('?')[0]?.slice(-40) || '')
                    : '等待自动捕获...';
            }

            const cntEl = $('s-cnt'); if (cntEl) cntEl.textContent = state.count;
            const okEl = $('s-ok'); if (okEl) okEl.textContent = state.stats.success;
            const errEl = $('s-err'); if (errEl) errEl.textContent = state.stats.errors;

            const goBtn = $('b-go');
            const stopBtn = $('b-stop');
            if (goBtn && stopBtn) {
                goBtn.style.display = state.status === 'retrying' ? 'none' : '';
                stopBtn.style.display = state.status === 'retrying' ? '' : 'none';
            }
        });
    }

    function appendLogDOM(entry) {
        const shadow = _shadowRef;
        if (!shadow) return;
        const el = shadow.getElementById('logs');
        if (!el) return;
        const div = document.createElement('div');
        div.className = entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : entry.msg.includes('成功') ? 'ok' : 'info';
        div.textContent = entry.ts + ' ' + entry.msg;
        el.appendChild(div);
        while (el.children.length > CFG.logMax) el.removeChild(el.firstChild);
        el.scrollTop = el.scrollHeight;
    }

    // ═══════════════════════════════════════════
    //  离开保护
    // ═══════════════════════════════════════════
    window.addEventListener('beforeunload', e => {
        if (state.status === 'retrying') {
            e.preventDefault();
            e.returnValue = '抢购正在进行中，确定要离开吗？';
        }
    });

    // ═══════════════════════════════════════════
    //  启动
    // ═══════════════════════════════════════════
    console.log('[GLM Rush Plus] v1.0.0 已注入 (真实触发版)');
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createPanel);
    } else {
        createPanel();
    }
})();
