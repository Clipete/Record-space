/* ============================================================
 * 记录空间 · 前端增强注入脚本
 * 适配线上：https://clipete.github.io/Record-space/
 * ------------------------------------------------------------
 * 不修改任何源码 / 不碰记录地图，只在页面加载后额外叠一层：
 *   1) 登录弹窗        —— 用户名密码登录，跨设备取回记录结构
 *   2) AI 引导解析     —— 引导页一键把自然语言交给 AI 抽成结构
 *   3) 反馈回传云端    —— 「就用推荐位置 / 我改到了别处」同步到云端
 *   4) 卡片换行        —— 修 AI 推荐卡片正文换行被吞掉的问题
 * 注入方式：在 index.html 的 </body> 前加 <script src="./inject.js"></script>
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 线上应用的存储键（与主应用一致） ----------
  const CFG = {
    workerKey:    'record_space_worker_url',
    tokenKey:     'record_space_access_token',
    dataKey:      'record-space-app-data',   // { software, records, feedback, hasOnboarded }
    userTokenKey: 'rs_user_token',           // 登录令牌（X-User-Token）
    usernameKey:  'rs_username',
    loggedInKey:  'rs_logged_in',
    skipOnceKey:  'rs_login_skipped',
  };

  // ---------- 存储 ----------
  const store = {
    raw(k) { return localStorage.getItem(k) || ''; },
    setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
    flag(k) { return localStorage.getItem(k) === '1'; },
    setFlag(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {} },
  };

  // ---------- 本地应用数据 ----------
  function readData() {
    const base = { software: [], records: [], feedback: [], hasOnboarded: false };
    try {
      const v = JSON.parse(localStorage.getItem(CFG.dataKey) || '{}');
      return Object.assign(base, v && typeof v === 'object' ? v : {});
    } catch (e) { return base; }
  }
  function writeData(d) {
    try { localStorage.setItem(CFG.dataKey, JSON.stringify(d)); } catch (e) {}
  }

  // 云端 structure → 本地 software
  function toSoftware(sources) {
    const stamp = Date.now();
    return (sources || []).map(function (s, i) {
      const name = String((s && s.name) || '').trim();
      return {
        id: 'rs-sw-' + i + '-' + stamp,
        name: name,
        icon: (name.charAt(0) || '?').toUpperCase(),
        recordCount: 0,
        folders: ((s && s.folders) || []).map(function (f, j) {
          const fname = String((typeof f === 'string' ? f : (f && f.name)) || '').trim();
          return { id: 'rs-f-' + i + '-' + j + '-' + stamp, name: fname, notes: [], recordCount: 0 };
        }),
      };
    });
  }

  // 本地 software → 云端 structure
  function toStructure(software) {
    return {
      sources: (software || []).map(function (s) {
        return {
          name: s.name,
          type: s.type || '电子',
          folders: (s.folders || []).map(function (f) { return { name: f.name }; }),
        };
      }),
    };
  }

  function parseJsonLoose(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  // ---------- 后端 API（阿里云函数计算） ----------
  const api = {
    base() { return (store.raw(CFG.workerKey) || '').replace(/\/+$/, ''); },
    accessToken() { return store.raw(CFG.tokenKey) || ''; },
    userToken() { return store.raw(CFG.userTokenKey) || ''; },

    req(path, opt) {
      opt = opt || {};
      const url = this.base() + path;
      const headers = Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {});
      const init = { method: opt.method || 'POST', headers: headers };
      if (opt.body !== undefined) init.body = JSON.stringify(opt.body);
      return fetch(url, init).then(function (res) {
        return res.text().then(function (t) {
          let d = null;
          try { d = JSON.parse(t); } catch (e) { d = { raw: t }; }
          return { ok: res.ok, status: res.status, data: d };
        });
      });
    },

    login(u, p) { return this.req('/auth/login', { body: { username: u, password: p } }); },
    register(u, p) { return this.req('/auth/register', { body: { username: u, password: p } }); },
    getMemory() { return this.req('/memory', { method: 'GET', headers: { 'X-User-Token': this.userToken() } }); },
    putMemory(m) { return this.req('/memory', { method: 'PUT', body: m, headers: { 'X-User-Token': this.userToken() } }); },
    extract(text) { return this.req('/extract-structure', { body: { text: text }, headers: { 'X-Access-Token': this.accessToken() } }); },
    chat(messages) { return this.req('/', { body: { messages: messages }, headers: { 'X-Access-Token': this.accessToken() } }); },
  };

  const loggedIn = function () { return !!api.userToken() && store.flag(CFG.loggedInKey); };

  // ---------- DOM 工具 ----------
  const $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function onElement(selector, cb) {
    const seen = new WeakSet();
    function scan() {
      $$(selector).forEach(function (el) {
        if (seen.has(el)) return;
        seen.add(el);
        try { cb(el); } catch (e) {}
      });
    }
    scan();
    const mo = new MutationObserver(scan);
    if (document.body) mo.observe(document.body, { childList: true, subtree: true });
  }

  // ---------- 样式 ----------
  function injectStyles() {
    if (document.getElementById('rs-inject-styles')) return;
    const css = [
      /* 4) AI 推荐卡片正文：保留换行 */
      'p.text-sm.text-text-primary.leading-relaxed{white-space:pre-line}',

      /* 登录浮层 */
      '.rs-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(30,27,22,.55);',
      '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;',
      'justify-content:center;padding:20px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
      '.rs-card{width:min(400px,92vw);background:#fffdf9;border:1px solid #e7e1d6;border-radius:20px;',
      'padding:30px 26px 22px;box-shadow:0 24px 70px rgba(60,50,30,.28);color:#2b2a28}',
      '.rs-card h2{margin:0 0 6px;font-size:19px;font-weight:600;text-align:center}',
      '.rs-sub{margin:0 0 20px;font-size:12.5px;color:#9a968e;text-align:center;line-height:1.6}',
      '.rs-card label{display:block;font-size:12.5px;color:#56534d;margin:0 0 6px}',
      '.rs-card input{width:100%;padding:10px 12px;border:1px solid #ddd5c7;border-radius:10px;',
      'font-size:14px;background:#fff;color:#2b2a28;box-sizing:border-box;outline:none;transition:border-color .18s,box-shadow .18s}',
      '.rs-card input:focus{border-color:#c9a96e;box-shadow:0 0 0 3px rgba(201,169,110,.16)}',
      '.rs-gap{height:14px}',
      '.rs-err{color:#c0563f;font-size:12px;margin-top:8px;min-height:16px;line-height:1.4}',
      '.rs-row{display:flex;gap:10px;margin-top:16px}',
      '.rs-btn{flex:1;padding:10px 14px;border:none;border-radius:999px;font-size:14px;cursor:pointer;',
      'font-weight:500;transition:opacity .2s,transform .1s;font-family:inherit}',
      '.rs-btn:active{transform:scale(.985)}',
      '.rs-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.rs-primary{background:#2b2a28;color:#fff}',
      '.rs-primary:hover{background:#1f1e1c}',
      '.rs-ghost{background:#fff;color:#56534d;border:1px solid #ddd5c7}',
      '.rs-ghost:hover{background:#f4f0e8}',
      '.rs-skip{display:block;margin:14px auto 0;background:none;border:none;color:#a89e8a;font-size:12px;',
      'cursor:pointer;text-decoration:underline;font-family:inherit}',

      /* AI 解析按钮 */
      '.rs-ai-btn{margin-top:10px;padding:7px 16px;background:#fff;border:1px solid #c9a96e;color:#8a6d33;',
      'border-radius:999px;font-size:12.5px;cursor:pointer;transition:all .18s;font-family:inherit}',
      '.rs-ai-btn:hover{background:#faf5eb;transform:translateY(-1px)}',
      '.rs-ai-btn:disabled{opacity:.55;cursor:not-allowed;transform:none}',

      /* 设置页登录状态 */
      '.rs-status{display:flex;align-items:center;gap:7px;font-size:12.5px;color:#9a968e;margin-top:10px}',
      '.rs-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px}',
      '.rs-dot.on{background:#4f8a5c}',
      '.rs-dot.off{background:#c9a96e}',
      '.rs-link{color:#8a6d33;text-decoration:underline;cursor:pointer;background:none;border:none;',
      'font-size:12.5px;font-family:inherit;padding:0}',
    ].join('');
    const style = document.createElement('style');
    style.id = 'rs-inject-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- 1) 登录弹窗 ----------
  let modalOpen = false;

  function showLogin(onDone) {
    if (modalOpen) return;
    modalOpen = true;

    const overlay = document.createElement('div');
    overlay.className = 'rs-overlay';
    overlay.innerHTML =
      '<div class="rs-card" role="dialog" aria-label="登录记录空间">' +
        '<h2>登录后同步</h2>' +
        '<p class="rs-sub">登录后，你的记录结构、分类偏好、反馈会存到云端。<br>换设备用同一个账号登录，就能取回全部记忆。</p>' +
        '<label>用户名</label>' +
        '<input id="rs-user" type="text" placeholder="字母 / 数字 / 下划线" autocomplete="username">' +
        '<div class="rs-gap"></div>' +
        '<label>密码</label>' +
        '<input id="rs-pw" type="password" placeholder="至少 6 位" autocomplete="current-password">' +
        '<div class="rs-err" id="rs-err"></div>' +
        '<div class="rs-row">' +
          '<button class="rs-btn rs-ghost" id="rs-reg">注册新空间</button>' +
          '<button class="rs-btn rs-primary" id="rs-login">登录</button>' +
        '</div>' +
        '<button class="rs-skip" id="rs-skip">先跳过，之后再说</button>' +
      '</div>';
    document.body.appendChild(overlay);

    const user = overlay.querySelector('#rs-user');
    const pw = overlay.querySelector('#rs-pw');
    const err = overlay.querySelector('#rs-err');
    const bLogin = overlay.querySelector('#rs-login');
    const bReg = overlay.querySelector('#rs-reg');
    const bSkip = overlay.querySelector('#rs-skip');

    function close() { overlay.remove(); modalOpen = false; }
    function setErr(m) { err.textContent = m || ''; }

    function afterAuth(username, token) {
      store.setRaw(CFG.userTokenKey, token);
      store.setRaw(CFG.usernameKey, username);
      store.setFlag(CFG.loggedInKey, true);
      // 若用户还没填过访问令牌，顺手填上，让 AI 对话开箱可用
      if (!store.raw(CFG.tokenKey)) store.setRaw(CFG.tokenKey, token);
    }

    function doLogin() {
      const u = user.value.trim();
      const p = pw.value.trim();
      if (!u) { setErr('请输入用户名'); return; }
      if (p.length < 6) { setErr('密码至少 6 位'); return; }
      setErr(''); bLogin.disabled = true;
      api.login(u, p).then(function (r) {
        bLogin.disabled = false;
        if (!r.ok) {
          setErr(r.status === 401 ? '用户名或密码不对' : (r.data && r.data.error) || '登录失败');
          return;
        }
        afterAuth(r.data.username || u, r.data.token);
        close();
        pullMemory().then(function () { if (onDone) onDone(); });
      }).catch(function () { bLogin.disabled = false; setErr('连不上服务器，检查下网络'); });
    }

    function doRegister() {
      const u = user.value.trim();
      const p = pw.value.trim();
      if (!u) { setErr('请输入用户名'); return; }
      if (p.length < 6) { setErr('密码至少 6 位'); return; }
      setErr(''); bReg.disabled = true;
      api.register(u, p).then(function (r) {
        bReg.disabled = false;
        if (!r.ok) {
          setErr(r.status === 409 ? '这个用户名已被占用，直接登录即可' : (r.data && r.data.error) || '注册失败');
          return;
        }
        afterAuth(r.data.username || u, r.data.token);
        // 把本机已有的结构推上云
        const d = readData();
        if ((d.software || []).length) {
          api.putMemory({ structure: toStructure(d.software), preferences: [], feedback: d.feedback || [] }).catch(function () {});
        }
        close();
        if (onDone) onDone();
      }).catch(function () { bReg.disabled = false; setErr('连不上服务器，检查下网络'); });
    }

    bLogin.addEventListener('click', doLogin);
    bReg.addEventListener('click', doRegister);
    bSkip.addEventListener('click', function () { try { sessionStorage.setItem(CFG.skipOnceKey, '1'); } catch (e) {} close(); });
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    user.addEventListener('keydown', function (e) { if (e.key === 'Enter') pw.focus(); });
    setTimeout(function () { user.focus(); }, 120);
  }

  // ---------- 云端记忆 → 本机 ----------
  function pullMemory() {
    if (!loggedIn()) return Promise.resolve(false);
    return api.getMemory().then(function (r) {
      if (!r.ok || !r.data || !r.data.memory) return false;
      const m = r.data.memory;
      const d = readData();
      let changed = false;

      const src = m.structure && m.structure.sources;
      if (Array.isArray(src) && src.length) {
        d.software = toSoftware(src);
        d.hasOnboarded = true;
        changed = true;
      }
      if (Array.isArray(m.feedback) && m.feedback.length) {
        d.feedback = m.feedback;
        changed = true;
      }
      if (changed) {
        writeData(d);
        setTimeout(function () { location.reload(); }, 400);
      }
      return changed;
    }).catch(function () { return false; });
  }

  // ---------- 本机 → 云端（结构 / 反馈） ----------
  function pushStructure() {
    if (!loggedIn()) return Promise.resolve(false);
    const d = readData();
    if (!(d.software || []).length) return Promise.resolve(false);
    return api.putMemory({
      structure: toStructure(d.software),
      feedback: d.feedback || [],
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  function pushFeedback() {
    if (!loggedIn()) return Promise.resolve(false);
    const d = readData();
    return api.putMemory({ feedback: d.feedback || [] })
      .then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  // ---------- 3) 反馈回传 ----------
  const FEEDBACK_LABELS = ['就用推荐位置', '我改到了别处', '保存反馈', '采纳并保存'];

  function setupFeedbackSync() {
    onElement('button', function (btn) {
      const label = (btn.textContent || '').trim();
      if (FEEDBACK_LABELS.indexOf(label) === -1) return;
      if (btn.dataset.rsFb) return;
      btn.dataset.rsFb = '1';
      btn.addEventListener('click', function () {
        // 等主应用把这条反馈写进 localStorage，再整体推上云
        setTimeout(function () { pushFeedback(); }, 1200);
      }, true);
    });
  }

  // ---------- 2) AI 引导解析 ----------
  async function aiExtract(text) {
    // 首选专用接口（需要「访问令牌」是主令牌）
    try {
      const r = await api.extract(text);
      if (r.ok && r.data && Array.isArray(r.data.sources) && r.data.sources.length) return r.data.sources;
    } catch (e) {}
    // 退路：借对话接口要一段 JSON
    try {
      const prompt =
        '把下面这句话里提到的「记录载体」和「文件夹」抽成 JSON，只输出 JSON，不要任何解释。\n' +
        '格式：{"sources":[{"name":"载体名","type":"电子","folders":[{"name":"文件夹名"}]}]}\n\n' +
        '我的话：' + text;
      const c = await api.chat([{ role: 'user', content: prompt }]);
      const j = c.ok && c.data ? parseJsonLoose(c.data.reply) : null;
      if (j && Array.isArray(j.sources) && j.sources.length) return j.sources;
    } catch (e) {}
    return null;
  }

  function setupAIOnboarding() {
    onElement('textarea[placeholder*="笔记结构"], input[placeholder*="笔记结构"]', function (input) {
      if (input.dataset.rsAi) return;
      input.dataset.rsAi = '1';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rs-ai-btn';
      btn.textContent = '✨ 用 AI 识别结构';

      // 插到输入框所在容器后面
      const anchor = input.closest('div') || input;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);

      btn.addEventListener('click', async function () {
        const text = (input.value || '').trim();
        if (!text) { btn.textContent = '先在框里描述一下你的记录方式'; setTimeout(function () { btn.textContent = '✨ 用 AI 识别结构'; }, 1800); return; }
        if (!api.base()) { btn.textContent = '需要先在「设置」里填代理 URL'; setTimeout(function () { btn.textContent = '✨ 用 AI 识别结构'; }, 2200); return; }

        btn.disabled = true;
        btn.textContent = 'AI 识别中…';
        const sources = await aiExtract(text);
        if (!sources) {
          btn.disabled = false;
          btn.textContent = '没识别出来，换个说法再试';
          setTimeout(function () { btn.textContent = '✨ 用 AI 识别结构'; }, 2200);
          return;
        }
        const d = readData();
        d.software = toSoftware(sources);
        d.hasOnboarded = true;
        writeData(d);
        pushStructure();
        btn.textContent = '已识别 ' + sources.length + ' 个载体，正在应用…';
        setTimeout(function () { location.reload(); }, 700);
      });
    });
  }

  // ---------- 设置页登录状态 / 入口 ----------
  function setupSettingsEntry() {
    onElement('div, h1, h2, h3, span, p', function (el) {
      if (el.dataset.rsSettingsDone) return;
      if ((el.textContent || '').trim() !== 'AI 助理接入') return;
      if (el.children.length > 0) return;

      // 往上找到「AI 助理接入」这张卡片（含密码输入框的那个祖先）
      let card = el, hops = 0;
      while (card && hops < 8) {
        if (card.querySelector && card.querySelector('input[type="password"]')) break;
        card = card.parentElement; hops++;
      }
      if (!card || !card.querySelector || !card.querySelector('input[type="password"]')) return;
      el.dataset.rsSettingsDone = '1';
      if (card.querySelector('.rs-status')) return;

      const bar = document.createElement('div');
      bar.className = 'rs-status';
      const on = loggedIn();
      bar.innerHTML =
        '<span class="rs-dot ' + (on ? 'on' : 'off') + '"></span>' +
        '<span>' + (on ? '已登录 · ' + (store.raw(CFG.usernameKey) || '') + ' · 云端同步中' : '未登录 · 数据只在本机') + '</span>';
      if (on) {
        const out = document.createElement('button');
        out.className = 'rs-link';
        out.textContent = '退出登录';
        out.addEventListener('click', function () {
          store.del(CFG.userTokenKey);
          store.del(CFG.usernameKey);
          store.setFlag(CFG.loggedInKey, false);
          location.reload();
        });
        bar.appendChild(out);
      } else {
        const go = document.createElement('button');
        go.className = 'rs-link';
        go.textContent = '登录以同步';
        go.addEventListener('click', function () { showLogin(function () {}); });
        bar.appendChild(go);
      }
      card.appendChild(bar);
    });
  }

  // ---------- 让 AI 对话用上账号记忆 ----------
  function patchFetch() {
    const orig = window.fetch;
    if (typeof orig !== 'function' || orig.__rsPatched) return;
    const wrapped = function (input, init) {
      try {
        const base = api.base();
        const token = api.userToken();
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (base && token && url.indexOf(base) === 0) {
          init = init || {};
          const h = new Headers(init.headers || (typeof input === 'string' ? {} : input.headers) || {});
          if (!h.has('X-User-Token')) h.set('X-User-Token', token);
          init.headers = h;
        }
      } catch (e) {}
      return orig.call(this, input, init);
    };
    wrapped.__rsPatched = true;
    window.fetch = wrapped;
  }

  // ---------- 启动 ----------
  function init() {
    if (window.__rsInjectLoaded) return;
    window.__rsInjectLoaded = true;

    injectStyles();
    patchFetch();
    setupFeedbackSync();
    setupAIOnboarding();
    setupSettingsEntry();

    const hasWorker = !!api.base();
    const on = loggedIn();

    if (hasWorker && on) {
      // 已登录：静默把本机结构补齐到云端，并拉一次云端
      setTimeout(function () { pushStructure(); }, 2500);
    } else if (hasWorker && !on) {
      // 没登录过：提示一次（本次会话跳过就不再打扰）
      let skipped = false;
      try { skipped = sessionStorage.getItem(CFG.skipOnceKey) === '1'; } catch (e) {}
      if (!skipped) setTimeout(function () { showLogin(function () {}); }, 2200);
    }

    console.log('%c记录空间 · 增强已加载', 'color:#c9a96e;font-weight:bold');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
