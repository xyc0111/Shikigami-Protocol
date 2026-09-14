/* =============================================================================
 * dh_live_bridge.js — 把 DH_live 的实时数字人渲染器（Qt WASM + WebGL2）
 * 嵌入宿主页面，并暴露口型驱动 API。
 *
 * 为什么是「同文档注入」而不是 iframe：
 *   DH 的渲染器依赖若干全局（Module / CONFIG / videoProcessor / 各 canvas 元素），
 *   口型由 Module._setAudioBuffer(ptr, len) 驱动。同文档注入后宿主可以同步直调，
 *   无需 postMessage 中转，音画也不会跨 frame 漂移。
 *
 * 对外 API（window.DHLiveAvatar）：
 *   mount(containerEl, { avatarId, baseDir })  注入 DOM + 加载 wasm + 启动渲染
 *   open() / close() / isOpen()                通话视图开关
 *   isReady()                                  渲染器是否就绪
 *   switchAvatar(avatarId)                     切换形象（形象与音色 1:1 绑定）
 *   pushWav(uint8arr)                          喂一段 16k/mono/PCM16 WAV 驱动口型
 *   interrupt()                                立即闭嘴（对应 Module._clearAudio）
 *   setMuted(bool) / isMuted()
 *   audioDestination(ctx)                      TTS 音频的接入口（串一个 GainNode，便于静音）
 *   on(event, fn)                              事件：'ready' | 'error' | 'open' | 'close'
 * ========================================================================== */
(function () {
  'use strict';

  /** 资源根目录：默认取本脚本所在目录（…/dh_live/），可被 mount() 的 baseDir 覆盖。 */
  var SCRIPT_BASE = (function () {
    var s = document.currentScript;
    if (s && s.src) return s.src.replace(/\/js\/[^/?#]*$/, '/');
    return '/dh_live/';
  })();

  var DEFAULT_AVATAR = 'avatars/dh_male_01';

  /** 渲染器要求的音频采样率（DH_live wasm 硬编码，勿改）。 */
  var DH_SR = 16000;

  /** 打断时补的静音尾长度。必须够长才能把嘴推回闭合位，又要够短以免拖慢下一句。 */
  var INTERRUPT_SILENCE_MS = 260;

  /* 内置形象清单（与 avatars/manifest.json 一致）。
     profile 里通过 dh_avatar_id 引用；形象与音色 1:1 绑定，由 profile 层保证一致。 */
  var AVATARS = [
    { id: 'avatars/dh_male_01',   name: '男性一' },
    { id: 'avatars/dh_female_01', name: '女性一' },
    { id: 'avatars/dh_avatar_03', name: '形象三' },
    { id: 'avatars/dh_avatar_05', name: '形象五' }
  ];

  var state = {
    baseDir: SCRIPT_BASE,
    avatarId: DEFAULT_AVATAR,
    container: null,
    mounted: false,
    mounting: null,      // Promise，便于并发 mount 去重
    ready: false,
    open: false,
    muted: false,
    gain: null,
    gainCtx: null,
    listeners: { ready: [], error: [], open: [], close: [] },
    lastError: null,
  };

  function emit(name, payload) {
    var arr = state.listeners[name] || [];
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](payload); } catch (e) { console.warn('[DHLiveAvatar] listener error', e); }
    }
  }

  /* ─────────────────────────── DOM 外壳 ───────────────────────────
   * MiniLive2.js 在脚本顶层就 document.getElementById 取这些节点并 getContext，
   * 所以必须在加载它之前把外壳插进文档，且 id 必须完全一致。
   * 与原版 MiniLive_RealTime.html 的差异：去掉下拉框与 dialog iframe（由宿主控制）。
   */
  var SHELL_ID = 'dh-live-shell';

  function ensureStyle() {
    if (document.getElementById('dh-live-style')) return;
    var css = [
      /* 通话舞台 */
      '#dh-call-overlay{position:fixed;inset:0;z-index:9000;background:#0b0d12;display:none;',
      '  flex-direction:column;align-items:center;justify-content:center;overflow:hidden;}',
      '#dh-call-overlay.dh-open{display:flex;}',
      '#dh-call-stage{position:absolute;inset:0;overflow:hidden;}',
      /* 与原版 MiniLive_RealTime.html 一致的定位规则，保证背景视频与人物画布对齐 */
      '#dh-call-stage #background_video{position:absolute;top:0;left:0;width:100%;height:100%;',
      '  object-fit:contain;z-index:0;}',
      '#dh-call-stage #canvas_video{position:absolute;top:0;left:0;width:100%;height:100%;',
      '  object-fit:contain;z-index:1;}',
      '#dh-call-stage #startMessage{position:absolute;top:60%;left:50%;transform:translate(-50%,-50%);',
      '  font-size:15px;font-weight:600;color:#cfd6e4;z-index:2;letter-spacing:.05em;}',
      /* 离屏节点：不参与布局，但必须存在且尺寸正确 */
      '#dh-live-shell #canvasEl,#dh-live-shell #canvas_gl{position:absolute;left:-9999px;top:-9999px;}',
      '#dh-live-shell #screen{position:absolute;bottom:-1000px;right:-1000px;width:1px;height:1px;}',
      /* 顶栏 */
      '#dh-call-bar{position:absolute;top:0;left:0;right:0;height:52px;z-index:5;display:flex;',
      '  align-items:center;gap:10px;padding:0 16px;background:linear-gradient(180deg,rgba(8,10,15,.85),rgba(8,10,15,0));}',
      '#dh-call-bar .dh-title{color:#e8edf7;font-size:14px;font-weight:600;flex:1;',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dh-btn{appearance:none;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);',
      '  color:#e8edf7;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;line-height:1.4;}',
      '.dh-btn:hover{background:rgba(255,255,255,.16);}',
      '.dh-btn.dh-on{background:rgba(255,255,255,.24);border-color:rgba(255,255,255,.34);}',
      /* 初始化遮罩 */
      '#dh-call-mask{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;',
      '  background:#0b0d12;color:#cfd6e4;font-size:14px;letter-spacing:.05em;flex-direction:column;gap:12px;}',
      '#dh-call-mask.dh-hide{display:none;}',
      '#dh-call-mask .dh-spin{width:26px;height:26px;border:2px solid rgba(255,255,255,.18);',
      '  border-top-color:#8ab4ff;border-radius:50%;animation:dhspin .9s linear infinite;}',
      '@keyframes dhspin{to{transform:rotate(360deg)}}',
      '#dh-call-mask .dh-err{color:#ff9a9a;max-width:70%;text-align:center;line-height:1.6;font-size:13px;}',
      /* 顶栏入口按钮 */
      '#dh-call-toggle{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}',
      '#dh-call-toggle.dh-live{color:#ff5b6e;}',
    ].join('');
    var el = document.createElement('style');
    el.id = 'dh-live-style';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function shellHTML() {
    return [
      '<div id="dh-call-stage">',
      '  <video id="background_video" muted loop playsinline autoplay></video>',
      '  <canvas id="canvas_video"></canvas>',
      '  <div id="startMessage">加载中</div>',
      '</div>',
      '<div id="dh-call-bar">',
      '  <span class="dh-title" id="dh-call-title">数字人通话</span>',
      '  <button type="button" class="dh-btn" id="dh-btn-mute" title="静音（只出画面）">🔊 有声</button>',
      '  <button type="button" class="dh-btn" id="dh-btn-close" title="关闭通话视图">关闭</button>',
      '</div>',
      '<div id="dh-call-mask"><div class="dh-spin"></div><div class="dh-mask-text">数字人渲染器加载中…</div></div>',
      /* 离屏节点（MiniLive2.js 顶层即取用，id 必须一致） */
      '<canvas id="canvasEl"></canvas>',
      '<canvas id="canvas_gl" width="184" height="184"></canvas>',
      '<div id="screen"></div>',
      /* 原版有角色下拉框；此处隐藏保留，避免渲染器告警，切换走 switchAvatar() */
      '<select id="characterDropdown" style="display:none"></select>',
    ].join('');
  }

  function injectShell(container) {
    var existing = document.getElementById(SHELL_ID);
    if (existing && existing !== container) existing.parentNode.removeChild(existing);
    if (!container.id) container.id = SHELL_ID;
    if (!container.querySelector('#canvas_video')) container.innerHTML = shellHTML();

    // MiniLive2.js 顶层会对 #canvasEl 做 getElementById 后取尺寸；这里给它初始尺寸
    var canvasEl = document.getElementById('canvasEl');
    if (canvasEl) { canvasEl.width = canvasEl.width || 300; canvasEl.height = canvasEl.height || 150; }

    bindShellEvents();
  }

  function bindShellEvents() {
    var closeBtn = document.getElementById('dh-btn-close');
    if (closeBtn && !closeBtn._dhBound) {
      closeBtn._dhBound = true;
      closeBtn.addEventListener('click', function () { api.close(); });
    }
    var muteBtn = document.getElementById('dh-btn-mute');
    if (muteBtn && !muteBtn._dhBound) {
      muteBtn._dhBound = true;
      muteBtn.addEventListener('click', function () { api.setMuted(!state.muted); });
    }
  }

  function syncMuteBtn() {
    var muteBtn = document.getElementById('dh-btn-mute');
    if (!muteBtn) return;
    muteBtn.textContent = state.muted ? '🔇 静音' : '🔊 有声';
    muteBtn.classList.toggle('dh-on', state.muted);
  }

  /* ─────────────────────────── 脚本加载 ─────────────────────────── */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;              // 保持执行顺序
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('脚本加载失败: ' + src)); };
      document.head.appendChild(s);
    });
  }

  function joinBase(p) {
    if (!p) return p;
    if (/^([a-z]+:)?\/\//i.test(p) || p.charAt(0) === '/') return p;
    return state.baseDir.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
  }

  /**
   * 生成一段 16k/单声道/PCM16 的静音 WAV（44 字节标准头 + 全零采样区）。
   * 用途：打断后把口型「推回」闭合位——wasm 不会因为缓冲清空而自动闭嘴。
   */
  function dhSilenceWav(ms) {
    var n = Math.max(1, Math.round(DH_SR * ms / 1000));
    var bytes = n * 2;
    var buf = new Uint8Array(44 + bytes);          // 采样区默认即 0
    var dv = new DataView(buf.buffer);
    function ascii(off, s) { for (var i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); }
    ascii(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);                     // PCM
    dv.setUint16(22, 1, true);                     // mono
    dv.setUint32(24, DH_SR, true);
    dv.setUint32(28, DH_SR * 2, true);             // byte rate
    dv.setUint16(32, 2, true);                     // block align
    dv.setUint16(34, 16, true);                    // bits
    ascii(36, 'data'); dv.setUint32(40, bytes, true);
    return buf;
  }

  /**
   * 从一整段 WAV 里切出第 index/total 片，并重建合法的 WAV 头。
   *
   * wasm 只接受完整 WAV（要解析头部），所以切片不能是裸 PCM，必须补头。
   * 做法：复用原文件 'data' 之前的全部字节作为模板（保留 fmt 等块），
   * 只改 RIFF size 与 data size 两个长度字段，再接上对应区间的采样数据。
   */
  function dhSliceWav(u8, index, total) {
    if (!u8 || u8.byteLength < 44) return null;
    // 逐个 chunk 找到 data 偏移（WAV 允许 fmt 之外还有 LIST 等块）
    var p = 12, dataOff = -1, dataLen = 0;
    while (p + 8 <= u8.byteLength) {
      var id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
      var sz = (u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24)) >>> 0;
      if (id === 'data') {
        dataOff = p + 8;
        dataLen = Math.min(sz, u8.byteLength - dataOff);
        break;
      }
      p += 8 + sz + (sz & 1);
    }
    if (dataOff < 0 || dataLen <= 0) return u8;   // 非标准布局：整段退回，宁可粗也不能错
    if (total <= 1) return u8;

    var per = Math.floor(dataLen / total);
    per -= per % 2;                                // 2 字节对齐（16bit 采样）
    if (per <= 0) return u8;

    var start = index * per;
    var end = (index === total - 1) ? dataLen : Math.min(start + per, dataLen);
    var len = end - start;
    if (len <= 0) return null;

    var out = new Uint8Array(dataOff + len);
    out.set(u8.subarray(0, dataOff), 0);           // 头部模板（含 'RIFF' 'WAVE' fmt… 'data'）
    out.set(u8.subarray(dataOff + start, dataOff + end), dataOff);

    var riffSize = dataOff + len - 8;
    out[4] = riffSize & 0xff; out[5] = (riffSize >> 8) & 0xff;
    out[6] = (riffSize >> 16) & 0xff; out[7] = (riffSize >> 24) & 0xff;
    var ds = dataOff - 4;                          // 'data' 块的长度字段
    out[ds] = len & 0xff; out[ds + 1] = (len >> 8) & 0xff;
    out[ds + 2] = (len >> 16) & 0xff; out[ds + 3] = (len >> 24) & 0xff;
    return out;
  }

  /* ─────────────────────────── 启动渲染器 ─────────────────────────── */

  async function boot(avatarId) {
    var base = state.baseDir;

    var mask = document.getElementById('dh-call-mask');
    var maskText = mask && mask.querySelector('.dh-mask-text');
    function setMask(t) { if (maskText) maskText.textContent = t; }

    setMask('加载渲染器脚本…');
    await loadScript(joinBase('js/pako.min.js'));
    await loadScript(joinBase('js/DHLiveMini.js'));
    await loadScript(joinBase('js/MiniLive2.js'));
    await loadScript(joinBase('js/qtloader.js'));

    /* 以下全局由 MiniLive2.js 以顶层 let/function 声明，处于全局词法环境，
       同一 realm 下的其它 classic script 可直接读写。 */
    if (typeof CONFIG === 'undefined' || typeof qtLoad !== 'function') {
      throw new Error('渲染器脚本未正确加载（CONFIG / qtLoad 缺失）');
    }

    CONFIG.baseDir = base;
    state.avatarId = avatarId || state.avatarId;
    // 上面 dhResolveAsset 会拼上 baseDir，这里保持相对写法
    CONFIG.videoSrc = state.avatarId + '/01.mp4';
    CONFIG.dataSrc = state.avatarId + '/combined_data.json.gz';
    CONFIG.backgroundVideoSrc = 'background/bg.mp4';
    CONFIG.chromaKeyEnabled = true;

    setMask('初始化 WebAssembly…');
    // 注意：qtLoad 会把 locateFile 包一层，对非 libQt6 的名字原样返回，
    // 裸文件名因此相对「文档基址」解析 —— 所以必须传绝对前缀。
    var screen = document.getElementById('screen');
    await qtLoad({
      // wasm 位于 baseDir 根（与 DH 原版布局一致：页面同目录，js 在 js/ 子目录）
      locateFile: function (name) { return joinBase(name); },
      qt: {
        entryFunction: window.createQtAppInstance,
        containerElements: [screen],
      },
    });

    setMask('加载形象数据…');
    await newVideoTask();

    state.ready = true;
    state.lastError = null;
    var m = document.getElementById('dh-call-mask');
    if (m) m.classList.add('dh-hide');
    emit('ready');
    return true;
  }

  function findAvatarEntry(avatarId) {
    var list = (window.__DH_LIVE_MANIFEST__ && window.__DH_LIVE_MANIFEST__.avatars) || AVATARS;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === avatarId) return list[i];
    }
    return null;
  }

  /* ─────────────────────────── 对外 API ─────────────────────────── */

  var api = {
    baseDir: SCRIPT_BASE,

    /** 注入 DOM + 加载 wasm + 启动渲染。可重复调用（幂等）。 */
    mount: function (container, opts) {
      opts = opts || {};
      if (opts.baseDir) state.baseDir = opts.baseDir;
      ensureStyle();

      var host = container || state.container || document.getElementById(SHELL_ID);
      if (!host) {
        host = document.createElement('div');
        host.id = SHELL_ID;
        host.className = 'dh-live-shell';
        document.body.appendChild(host);
      }
      state.container = host;
      injectShell(host);

      if (state.mounted && state.ready) return Promise.resolve(true);
      if (state.mounting) return state.mounting;

      var avatarId = opts.avatarId || state.avatarId || DEFAULT_AVATAR;
      state.mounting = boot(avatarId).catch(function (err) {
        state.lastError = err;
        console.error('[DHLiveAvatar] 初始化失败:', err);
        var mask = document.getElementById('dh-call-mask');
        if (mask) {
          mask.classList.remove('dh-hide');
          mask.innerHTML = '<div class="dh-err">数字人渲染器初始化失败：<br>' +
            String(err && err.message || err) + '</div>';
        }
        emit('error', err);
        throw err;
      }).then(function (r) { state.mounted = true; state.mounting = null; return r; },
              function (e) { state.mounting = null; throw e; });

      return state.mounting;
    },

    /** 打开通话视图（首次调用会自动 mount）。 */
    open: async function (opts) {
      opts = opts || {};
      ensureStyle();
      var overlay = document.getElementById('dh-call-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dh-call-overlay';
        overlay.innerHTML = '<div id="' + SHELL_ID + '" class="dh-live-shell"></div>';
        document.body.appendChild(overlay);
      }
      var host = overlay.querySelector('#' + SHELL_ID) || overlay.firstElementChild;
      var wasOpen = state.open;
      state.open = true;
      overlay.classList.add('dh-open');
      if (!wasOpen) emit('open');

      try {
        await api.mount(host, opts);
      } catch (e) {
        // 失败时保留遮罩与错误信息，便于排查
      }
      api._syncTitle();
      return true;
    },

    close: function () {
      var overlay = document.getElementById('dh-call-overlay');
      if (overlay) overlay.classList.remove('dh-open');
      if (state.open) emit('close');
      state.open = false;
      // 关闭时让数字人闭嘴，避免残留的音频缓冲继续驱动口型
      api.interrupt();
      return true;
    },

    toggle: function (opts) {
      if (state.open) { api.close(); return Promise.resolve(false); }
      return api.open(opts).then(function () { return true; });
    },

    isOpen: function () { return !!state.open; },
    isReady: function () { return !!state.ready; },
    isActive: function () { return !!(state.open && state.ready); },
    lastError: function () { return state.lastError; },

    /** 切换形象。形象与音色 1:1 绑定，由 profile 层保证一致。 */
    switchAvatar: async function (avatarId) {
      if (!avatarId) return false;
      if (!state.ready) { state.avatarId = avatarId; return false; }
      if (typeof window.dhSwitchAvatar !== 'function') return false;
      state.avatarId = avatarId;
      // dhSwitchAvatar 接收相对于 CONFIG.baseDir 的路径
      await window.dhSwitchAvatar(avatarId);
      api._syncTitle();
      return true;
    },

    /** 喂一段音频驱动口型。必须在 source.start() 之前调用，保持串行。 */
    pushWav: function (u8) {
      if (!state.ready || !u8 || !u8.byteLength) return false;
      if (typeof Module === 'undefined' || !Module || typeof Module._setAudioBuffer !== 'function') return false;
      // 只吃 16k/单声道/PCM16 WAV。既非 WAV 就跳过——服务端转码失败时会降级下发
      // provider 原生格式（如 MP3）以保证用户听得到声音，那种片段喂进去只会让口型乱跳。
      if (u8.byteLength < 12 || u8[0] !== 0x52 || u8[1] !== 0x49 || u8[2] !== 0x46 || u8[3] !== 0x46) {
        return false;   // 非 "RIFF"
      }
      try {
        var ptr = Module._malloc(u8.byteLength);
        Module.HEAPU8.set(u8, ptr);
        Module._setAudioBuffer(ptr, u8.byteLength);
        Module._free(ptr);
        return true;
      } catch (e) {
        console.warn('[DHLiveAvatar] pushWav failed:', e);
        return false;
      }
    },

    /* ─────────────── 按播放节奏切片推送 ───────────────
     * 实测结论（见 avatar.html 的 A/B 实验）：wasm 的 _clearAudio() 只丢弃
     * 「尚未被消费」的缓冲，不会中断已经推入的那一段。若按整句（1~3s）推送，
     * 用户打断后画面仍会把整句嘴型做完——barge-in 形同虚设。
     *
     * 对策：把一句音频切成 ~180ms 的小片，随实际播放进度推给 wasm。
     * 打断时最多残留一片，视觉上不可感知。
     */
    _paceTimers: [],

    /** 清掉未到期的切片定时器（打断/换句/卸载时调用）。 */
    _clearPacing: function () {
      for (var i = 0; i < api._paceTimers.length; i++) clearTimeout(api._paceTimers[i]);
      api._paceTimers = [];
    },

    /**
     * 按播放节奏推送一段音频。
     * @param {Uint8Array} u8        16k/单声道/PCM16 WAV 全量字节
     * @param {number} durationSec   该段音频的播放时长（宿主已 decode，可直接给 buffer.duration）
     * @param {{sliceMs?:number, leadMs?:number}} [opts]
     */
    pushPaced: function (u8, durationSec, opts) {
      api._clearPacing();
      // 丢弃上一段的残留（含打断时补的静音尾），否则口型会整体滞后一截
      api.interrupt({ noSilence: true });
      opts = opts || {};
      var sliceMs = opts.sliceMs || 180;
      var leadMs = opts.leadMs || 360;         // 预推一点，避免 wasm 侧欠载导致口型卡顿
      var total = Math.max(1, Math.ceil((durationSec * 1000) / sliceMs));
      for (var i = 0; i < total; i++) {
        (function (idx) {
          var delay = idx * sliceMs - leadMs;
          var run = function () {
            var piece = dhSliceWav(u8, idx, total);
            if (piece) api.pushWav(piece);
          };
          if (delay <= 0) run();
          else api._paceTimers.push(setTimeout(run, delay));
        })(i);
      }
      return total;
    },

    /** 打断：停掉后续切片 + 清 wasm 内的待消费缓冲。 */
    interrupt: function () {
      api._clearPacing();
      if (typeof Module === 'undefined' || !Module || typeof Module._clearAudio !== 'function') return false;
      try { Module._clearAudio(); return true; } catch (e) { return false; }
    },

    setMuted: function (m) {
      state.muted = !!m;
      if (state.gain) state.gain.gain.value = state.muted ? 0 : 1;
      syncMuteBtn();
      return state.muted;
    },
    isMuted: function () { return !!state.muted; },

    /**
     * 宿主 TTS 音频的接入口。通话视图打开时返回一个 GainNode
     * （静音只影响出声，播放时钟照走，口型不会因此停摆）；
     * 未打开时返回 null，宿主回退到 ctx.destination。
     */
    audioDestination: function (ctx) {
      if (!ctx || !state.open) return null;
      if (state.gainCtx !== ctx) {
        try { state.gain = ctx.createGain(); } catch (e) { return null; }
        state.gain.connect(ctx.destination);
        state.gainCtx = ctx;
      }
      state.gain.gain.value = state.muted ? 0 : 1;
      return state.gain;
    },

    currentAvatar: function () { return state.avatarId; },
    avatarEntry: function (id) { return findAvatarEntry(id || state.avatarId); },

    /** 暴露切片器/静音生成器，供冒烟页与调试自检使用。 */
    sliceWav: function (u8, index, total) { return dhSliceWav(u8, index, total); },
    silenceWav: function (ms) { return dhSilenceWav(ms); },
    interruptSilenceMs: INTERRUPT_SILENCE_MS,

    on: function (name, fn) {
      if (state.listeners[name] && typeof fn === 'function') state.listeners[name].push(fn);
      return api;
    },

    _syncTitle: function (t) {
      var el = document.getElementById('dh-call-title');
      if (!el) return;
      var entry = findAvatarEntry(state.avatarId);
      var name = (t || (entry && entry.name) || '').trim();
      el.textContent = name ? ('数字人通话 · ' + name) : '数字人通话';
    },
  };

  /* ─────────────────── 顶栏入口按钮（宿主为 Shikigami） ─────────────────── */

  function injectToggleButton(host) {
    if (document.getElementById('dh-call-toggle')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolbar-btn';
    btn.id = 'dh-call-toggle';
    btn.title = '数字人视频聊天（新窗口）';
    btn.innerHTML = '<span>🎭</span>';
    btn.addEventListener('click', function () {
      // 独立视频聊天页：数字人舞台 + 形象选择 + 文本/图片对话，
      // 不再占用主窗口的通话视图（老入口 api.toggle() 仍保留可编程调用）。
      window.open(SCRIPT_BASE + 'stage.html', '_blank');
    });
    if (host) {
      var gear = host.querySelector('.gear-btn');
      if (gear) host.insertBefore(btn, gear); else host.appendChild(btn);
    } else {
      btn.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:8000;';
      document.body.appendChild(btn);
    }
  }

  /** 通话视图开关会改变 TTS 音频格式（format=dh 返回 16k 单声道 WAV），需重连 WS。 */
  function notifyTtsReconnect() {
    var app = window.__shikigamiApp;
    if (!app) return;
    try {
      if (typeof app.stopTTSPlayback === 'function') app.stopTTSPlayback();
      if (typeof app.disconnectTTS === 'function') app.disconnectTTS();
      if (app.ttsEnabled !== false && typeof app.connectTTS === 'function') app.connectTTS();
    } catch (e) {
      console.warn('[DHLiveAvatar] TTS 重连失败:', e);
    }
  }

  function hasStageEntry() {
    return !!(document.getElementById('dh-call-toggle') ||
              document.querySelector('.dh-stage-btn'));
  }

  function autoInject() {
    if (hasStageEntry()) return true;   // index.html 模板已内置按钮（.dh-stage-btn），不重复注入
    // 优先放语音聊天按钮所在的工具栏，退而求其次顶栏右侧，最后右下角悬浮
    var host = document.querySelector('.chat-toolbar') ||
               document.querySelector('.header-right');
    if (!host) return false;
    injectToggleButton(host);
    console.info('[DHLiveAvatar] 工具栏入口已注入');
    return true;
  }

  // .header-right 若被前端框架异步渲染，DOMContentLoaded 时可能还不存在：
  // 轮询等待最多 15s；仍未出现且非独立冒烟页时，退化为右下角悬浮按钮，
  // 保证任何宿主页面都有数字人入口，而不是静默失败。
  function startInjectWatch() {
    console.info('[DHLiveAvatar] bridge loaded @', location.pathname);
    var tries = 0;
    var timer = setInterval(function () {
      if (autoInject()) { clearInterval(timer); return; }
      if (++tries >= 50) {
        clearInterval(timer);
        var onStandalonePage = /\/dh_live\/[a-z0-9_]+\.html$/i.test(location.pathname);
        if (!onStandalonePage) {
          injectToggleButton();
          console.warn('[DHLiveAvatar] 15s 内未出现 .header-right，已注入右下角悬浮按钮');
        }
      }
    }, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startInjectWatch);
  } else {
    startInjectWatch();
  }

  window.DHLiveAvatar = api;
})();
