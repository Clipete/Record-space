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

  // 云端 structure → 本地 software（支持三级：软件 › 文件夹 › 笔记）
  function toSoftware(sources) {
    const stamp = Date.now();
    return (sources || []).map(function (s, i) {
      const name = String((s && s.name) || '').trim();
      const folders = ((s && s.folders) || []).map(function (f, j) {
        const fname = String((typeof f === 'string' ? f : (f && f.name)) || '').trim();
        const notes = ((typeof f === 'object' && f && f.notes) || []).map(function (n, k) {
          const nname = String((typeof n === 'string' ? n : (n && n.name)) || '').trim();
          return { id: 'rs-n-' + i + '-' + j + '-' + k + '-' + stamp, name: nname, recordCount: 0 };
        }).filter(function (n) { return n.name; });
        return { id: 'rs-f-' + i + '-' + j + '-' + stamp, name: fname, notes: notes, recordCount: 0 };
      }).filter(function (f) { return f.name; });
      return {
        id: 'rs-sw-' + i + '-' + stamp,
        name: name,
        icon: (name.charAt(0) || '?').toUpperCase(),
        recordCount: 0,
        folders: folders,
      };
    }).filter(function (s) { return s.name; });
  }

  // 本地 software → 云端 structure（software / records 原样带上，保证换设备能完整还原）
  function toStructure(software) {
    const d = readData();
    return {
      software: software || [],
      records: d.records || [],
      sources: (software || []).map(function (s) {
        return {
          name: s.name,
          type: s.type || '电子',
          folders: (s.folders || []).map(function (f) {
            return {
              name: f.name,
              notes: (f.notes || []).map(function (n) { return { name: n.name }; }),
            };
          }),
        };
      }),
    };
  }

  // 合并两套结构：同名软件/文件夹/笔记保留原有的，只补新的，绝不整片覆盖
  function mergeSoftware(oldList, newList) {
    const out = (oldList || []).map(function (s) {
      return Object.assign({}, s, { folders: (s.folders || []).slice() });
    });
    (newList || []).forEach(function (ns) {
      const name = String(ns.name || '').trim();
      if (!name) return;
      const idx = out.findIndex(function (s) { return String(s.name || '').trim() === name; });
      if (idx < 0) { out.push(ns); return; }
      const cur = out[idx];
      const folders = (cur.folders || []).slice();
      (ns.folders || []).forEach(function (nf) {
        const fname = String(nf.name || '').trim();
        if (!fname) return;
        const fi = folders.findIndex(function (f) { return String(f.name || '').trim() === fname; });
        if (fi < 0) { folders.push(nf); return; }
        const notes = (folders[fi].notes || []).slice();
        (nf.notes || []).forEach(function (nn) {
          const nname = String(nn.name || '').trim();
          if (!nname) return;
          if (!notes.some(function (n) { return String(n.name || '').trim() === nname; })) notes.push(nn);
        });
        folders[fi] = Object.assign({}, folders[fi], { notes: notes });
      });
      out[idx] = Object.assign({}, cur, { folders: folders });
    });
    return out;
  }

  // 合并记录：按 id 去重，本机已有的优先
  function mergeRecords(local, remote) {
    const out = (local || []).slice();
    const ids = {};
    out.forEach(function (r) { if (r && r.id) ids[r.id] = true; });
    (remote || []).forEach(function (r) {
      if (!r) return;
      if (r.id && ids[r.id]) return;
      out.push(r);
      if (r.id) ids[r.id] = true;
    });
    return out;
  }

  // ---------- 本机自动备份 + 空数据自愈 ----------
  const BACKUP_KEY = 'rs_data_backup';
  const RESTORE_FLAG = 'rs_restored_once';

  function backupNow() {
    const d = readData();
    if ((d.software || []).length || (d.records || []).length) {
      try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ at: Date.now(), data: d })); } catch (e) {}
    }
  }

  function restoreIfWiped() {
    const d = readData();
    const emptyNow = !(d.software || []).length && !(d.records || []).length;
    if (!emptyNow) return false;
    let used = false;
    try { used = sessionStorage.getItem(RESTORE_FLAG) === '1'; } catch (e) {}
    if (used) return false;
    try {
      const b = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null');
      const bd = b && b.data;
      if (bd && (((bd.software || []).length) || ((bd.records || []).length))) {
        writeData(Object.assign({}, bd, { hasOnboarded: true }));
        try { sessionStorage.setItem(RESTORE_FLAG, '1'); } catch (e) {}
        console.warn('[RS Inject] 数据意外变空，已从本机备份恢复并刷新');
        location.reload();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function setupBackup() {
    backupNow();
    setInterval(backupNow, 5000);
    window.addEventListener('beforeunload', backupNow);
    // 用户主动「清空所有数据」时，备份也一起清掉，避免被自动救回来
    onElement('button', function (btn) {
      const label = (btn.textContent || '').trim();
      if (label !== '清空所有数据' && label !== '重新配置记录结构') return;
      if (btn.dataset.rsClear) return;
      btn.dataset.rsClear = '1';
      btn.addEventListener('click', function () {
        try { localStorage.removeItem(BACKUP_KEY); } catch (e) {}
      }, true);
    });
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
        try { cb(el); } catch (e) { console.warn('[RS Inject] 处理元素出错：', e && e.message, el); }
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

      const st = m.structure || {};
      let incoming = [];
      if (Array.isArray(st.software) && st.software.length) incoming = st.software;
      else if (Array.isArray(st.sources) && st.sources.length) incoming = toSoftware(st.sources);
      if (incoming.length) {
        d.software = mergeSoftware(d.software, incoming);
        d.hasOnboarded = true;
        changed = true;
      }
      if (Array.isArray(st.records) && st.records.length) {
        const mergedR = mergeRecords(d.records, st.records);
        if (mergedR.length !== (d.records || []).length) { d.records = mergedR; changed = true; }
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
  // 场景化指令：让 AI 明确知道自己「在哪个环境里、要产出什么东西」
  const EXTRACT_SCENE =
    '【当前场景】你是「记录空间」这个笔记管理 App 里、新手引导步骤的"结构识别助手"。' +
    '用户正在用一句自然语言描述：他平时用什么软件／本子记东西、每个载体里有哪些文件夹、文件夹里又放了哪些笔记。\n' +
    '【你的任务】把这句话解析成三级结构：软件 › 文件夹 › 笔记。\n' +
    '【只输出 JSON，不要任何解释文字、不要 Markdown、不要代码块围栏】\n' +
    '格式：{"software":[{"name":"软件名","type":"电子","folders":[{"name":"文件夹名","notes":[{"name":"笔记名"}]}]}]}\n' +
    '【规则】\n' +
    '1. 只能使用用户原话里出现过的名称，绝对不许编造。\n' +
    '2. 用户没提到的层级就给空数组，不要为了凑数加"未分类""其他"这类词。\n' +
    '3. type 只能是「电子」或「纸质」。\n' +
    '4. 名称要去掉"我用""用来做""平时会"这类前缀词。\n' +
    '5. 如果这句话完全没提到任何记录载体，返回 {"software":[]}。\n';

  // 本地兜底解析：AI 完全不可用时也不会毫无反应
  const KNOWN_APPS = ['notion', 'goodnotes', 'obsidian', '幕布', '印象笔记', 'evernote', 'onenote',
    '苹果备忘录', '备忘录', '语雀', '飞书文档', 'flomo', '浮墨', 'wolai', '我来', '有道云笔记',
    'bear', 'craft', 'logseq', 'roam research', '思源', 'siyuan', '腾讯文档', '石墨', 'typora'];

  function localExtract(text) {
    const out = [];
    const segs = String(text || '').split(/[；;。\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    segs.forEach(function (seg) {
      const low = seg.toLowerCase();
      let name = '';
      for (let i = 0; i < KNOWN_APPS.length; i++) {
        const k = KNOWN_APPS[i];
        const p = low.indexOf(k);
        if (p >= 0) { name = seg.substr(p, k.length); break; }
      }
      if (!name) {
        const m = seg.match(/(?:用|在|拿|靠)\s*([^\s，,、。；;：:]{2,12}?)(?=来|做|记|写|管理|整理|存|放|笔记)/);
        if (m) name = m[1];
      }
      if (!name) return;
      let folders = [];
      const fm = seg.match(/(?:有|包含|分成|分为|里面(?:有)?|下有|分别有)\s*([^。；;]*)/);
      if (fm) {
        folders = fm[1].split(/[、,，\/]/).map(function (s) {
          return s.replace(/[「」“”"'’]/g, '')
            .replace(/^(?:个|这些|那些|的)/, '')
            .replace(/(?:文件夹|目录|栏目|分类|两个|三个|若干)$/, '')
            .trim();
        }).filter(function (s) { return s && s.length <= 20; });
      }
      out.push({
        name: name,
        type: /纸|手写|本子/.test(seg) ? '纸质' : '电子',
        folders: folders.map(function (f) { return { name: f, notes: [] }; }),
      });
    });
    return out;
  }

  // 返回 { software, via, error }
  async function aiExtract(text) {
    if (!api.base()) return { software: [], via: 'none', error: 'NO_WORKER' };
    const token = api.accessToken();
    if (!token || token.length < 6) return { software: [], via: 'none', error: 'NO_TOKEN' };

    // 路径一：专用接口（只有「访问令牌」正好是主令牌时才能用，最省额度）
    try {
      const r = await api.extract(text);
      if (r.ok && r.data && Array.isArray(r.data.sources) && r.data.sources.length) {
        return { software: r.data.sources, via: 'extract', error: '' };
      }
    } catch (e) { /* 落到路径二 */ }

    // 路径二：对话接口 + 完整场景说明（任意 ≥6 位密码都能走通）
    try {
      const c = await api.chat([{ role: 'user', content: EXTRACT_SCENE + '\n用户的话：' + text }]);
      if (c.ok && c.data) {
        const j = parseJsonLoose(c.data.reply);
        const list = j && (j.software || j.sources);
        if (Array.isArray(list) && list.length) return { software: list, via: 'ai', error: '' };
      } else if (c.status === 401) {
        return { software: [], via: 'none', error: 'BAD_TOKEN' };
      }
    } catch (e) { /* 落到路径三 */ }

    // 路径三：本地规则兜底
    const local = localExtract(text);
    if (local.length) return { software: local, via: 'local', error: '' };
    return { software: [], via: 'none', error: 'NO_MATCH' };
  }

  function summarize(software) {
    let f = 0, n = 0;
    (software || []).forEach(function (s) {
      (s.folders || []).forEach(function (x) { f++; n += (x.notes || []).length; });
    });
    return software.length + ' 个载体 / ' + f + ' 个文件夹 / ' + n + ' 条笔记';
  }

  function setupAIOnboarding() {
    onElement('textarea[placeholder*="笔记结构"], input[placeholder*="笔记结构"]', function (input) {
      if (input.dataset.rsAi) return;
      input.dataset.rsAi = '1';

      const IDLE = '✨ 用 AI 识别结构（软件 › 文件夹 › 笔记）';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rs-ai-btn';
      btn.textContent = IDLE;

      const anchor = input.closest('div') || input;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);

      let timer = null;
      function say(msg, backMs) {
        btn.textContent = msg;
        if (timer) clearTimeout(timer);
        if (backMs) timer = setTimeout(function () { btn.textContent = IDLE; btn.disabled = false; }, backMs);
      }

      btn.addEventListener('click', async function () {
        const text = (input.value || '').trim();
        if (!text) { say('先在框里描述一下你的记录方式', 2000); return; }

        btn.disabled = true;
        btn.textContent = 'AI 识别中…';
        const res = await aiExtract(text);

        if (!res.software.length) {
          if (res.error === 'NO_WORKER') say('还没配代理 URL：去「设置 → AI 助理接入」', 3500);
          else if (res.error === 'NO_TOKEN') say('还没填访问令牌：去「设置 → AI 助理接入」', 3500);
          else if (res.error === 'BAD_TOKEN') say('访问令牌不对，去「设置」检查一下', 3500);
          else say('没认出结构，说的时候带上软件名和文件夹', 3000);
          return;
        }

        const list = toSoftware(res.software);
        const d = readData();
        const before = (d.software || []).length;
        d.software = mergeSoftware(d.software, list);
        d.hasOnboarded = true;
        writeData(d);
        backupNow();
        pushStructure();
        const tag = res.via === 'local' ? '（本地规则，AI 未接入）' : '';
        const added = d.software.length - before;
        say('已识别：' + summarize(list) + tag + (added > 0 ? '，新增 ' + added + ' 个载体' : '，已并入现有结构') + '，正在应用…', 0);
        setTimeout(function () { location.reload(); }, 900);
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

    // 数据被意外清空时，先从本机备份救回来（会触发一次刷新）
    if (restoreIfWiped()) return;

    // 调试用：可在控制台直接调 window.__rsInject.aiExtract('我用 Notion…')
    window.__rsInject = {
      aiExtract: aiExtract, toSoftware: toSoftware, toStructure: toStructure,
      localExtract: localExtract, summarize: summarize, readData: readData,
      mergeSoftware: mergeSoftware, mergeRecords: mergeRecords,
      backupNow: backupNow, restoreIfWiped: restoreIfWiped,
      pushStructure: pushStructure, pullMemory: pullMemory, api: api,
    };

    injectStyles();
    setupBackup();
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
