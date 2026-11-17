/* ============================================================================
 * app.js — 工具页逻辑。
 * 数据来自两处：① 书签脚本在同源环境拉取后 postMessage 推来（src:"ds-bm"）；
 *              ② 用户手动粘贴 JSON / 文本。本文件不直接调用 DeepSeek 接口
 *              （浏览器跨域限制，见 README）。
 * ========================================================================== */
(function () {
  "use strict";
  if (window.__dsWebApp) return;
  window.__dsWebApp = true;

  const $ = (s, el) => (el || document).querySelector(s);
  const esc = DSExp.escapeHtml;
  const fmtTime = (ts) => (ts ? DSExp.fmtDateTime(ts) : "");

  // ---------------- 状态 ----------------

  const sessions = new Map(); // id -> {id,title,updated_at,model_type,messages?,detailReady}
  let order = [];
  let selectedId = null;

  function upsertMeta(m) {
    if (!m || !m.id) return;
    sessions.set(m.id, Object.assign({}, sessions.get(m.id) || {}, m));
    if (!order.includes(m.id)) order.push(m.id);
  }
  function setDetail(s) {
    if (!s || !s.id) return;
    sessions.set(s.id, Object.assign({}, sessions.get(s.id) || {}, s, { detailReady: true }));
    if (!order.includes(s.id)) order.push(s.id);
  }

  // ---------------- 与书签脚本的桥 ----------------

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.src !== "ds-bm") return;
    if (d.type === "list" && Array.isArray(d.sessions)) {
      d.sessions.forEach(upsertMeta);
      ack();
      renderList();
      setStatus("已收到会话列表（" + d.sessions.length + " 个），详情陆续接收中…");
    } else if (d.type === "detail" && d.session) {
      setDetail(d.session);
      if (selectedId === d.session.id) renderPreview();
      renderList();
      ack();
    } else if (d.type === "progress") {
      setStatus("接收进度：" + d.got + " / " + d.total);
    } else if (d.type === "error") {
      toast("⚠ " + d.message, true);
      ack();
    }
  });

  /** 回执：告诉书签脚本"网页已就绪"，它据此停止重发列表。 */
  function ack() {
    if (window.opener && !window.opener.closed) {
      try { window.opener.postMessage({ src: "ds-page", type: "ack" }, "*"); } catch (_) {}
    }
  }

  // ---------------- 列表 / 预览 ----------------

  function renderList() {
    const box = $("#session-list");
    box.innerHTML = "";
    if (!order.length) {
      box.innerHTML = '<div class="empty">还没有数据。<br>按上方「三步上手」操作后，会话会出现在这里。</div>';
      $("#stats").textContent = "";
      return;
    }
    for (const id of order) {
      const s = sessions.get(id);
      const row = document.createElement("div");
      row.className = "row" + (id === selectedId ? " active" : "");
      row.innerHTML =
        '<div class="row-title">' + esc(s.title || "(未命名会话)") + "</div>"
        + '<div class="row-meta">'
        + (s.detailReady
            ? (s.messages ? s.messages.length : 0) + " 条消息 · "
            : "详情接收中… · ")
        + fmtTime(s.updated_at) + "</div>";
      row.onclick = () => { selectedId = id; renderList(); renderPreview(); };
      box.appendChild(row);
    }
    const ready = [...sessions.values()].filter((s) => s.detailReady).length;
    $("#stats").textContent = "共 " + order.length + " 个会话 · " + ready + " 个详情就绪";
  }

  function renderPreview() {
    const box = $("#preview");
    const s = sessions.get(selectedId);
    if (!s) { box.innerHTML = '<div class="empty">← 从左侧选择一个会话</div>'; return; }
    if (!s.detailReady) { box.innerHTML = '<div class="empty">该会话详情还在接收中……</div>'; return; }
    box.innerHTML =
      '<div class="pv-head"><div class="pv-title">' + esc(s.title || "(未命名会话)") + "</div>"
      + '<div class="pv-meta">'
      + (s.id ? "ID " + esc(s.id) + " · " : "")
      + (s.model_type ? esc(s.model_type) + " · " : "")
      + fmtTime(s.updated_at) + "</div></div>"
      + '<div class="pv-actions">'
      + '<button id="btn-html" class="primary">⬇ 导出 HTML</button>'
      + '<button id="btn-txt">⬇ 导出 TXT</button></div>'
      + '<div class="pv-body">' + DSExp.renderMessagesHtml(s.messages) + "</div>";
    $("#btn-html").onclick = () => exportOne(s, "html");
    $("#btn-txt").onclick = () => exportOne(s, "txt");
  }

  // ---------------- 导出 ----------------

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function exportOne(s, fmt) {
    if (!s || !s.detailReady) return;
    const name = "DeepSeek_" + DSExp.sanitizeFilename(s.title) + "_"
               + DSExp.stampForFilename() + "." + fmt;
    const content = fmt === "html" ? DSExp.buildHtml(s) : DSExp.buildTxt(s);
    download(name, content, fmt === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8");
    toast("已导出：" + name);
  }

  function exportAll(fmt) {
    const ready = order.map((id) => sessions.get(id)).filter((s) => s && s.detailReady);
    if (!ready.length) { toast("还没有详情就绪的会话", true); return; }
    if (!confirm("将逐个下载 " + ready.length + " 个 " + fmt.toUpperCase() + " 文件，继续？")) return;
    ready.forEach((s, i) => setTimeout(() => exportOne(s, fmt), i * 600));
  }

  // ---------------- 兜底：粘贴导入 ----------------

  function fromHistoryDump(raw) {
    let biz = raw;
    if (raw && typeof raw === "object" && raw.data && raw.data.biz_data) biz = raw.data.biz_data;
    else if (raw && typeof raw === "object" && raw.biz_data) biz = raw.biz_data;
    if (biz && Array.isArray(biz.chat_messages)) {
      const cs = biz.chat_session || {};
      const s = DSExp.normalizeSession(cs, biz.chat_messages);
      if (!s.id) s.id = "imported-" + Math.random().toString(36).slice(2, 8);
      return s;
    }
    return null;
  }

  function importJson(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (e) { toast("JSON 解析失败：" + e.message, true); return; }
    const ensureId = (s) => { if (s && !s.id) s.id = "imp-" + Math.random().toString(36).slice(2, 8); return s; };
    const loaded = [];
    if (raw && raw.format === "deepseek-export/v1" && Array.isArray(raw.sessions)) {
      raw.sessions.forEach((s) => setDetail(ensureId(s)));
      loaded.push("ok");
    } else if (Array.isArray(raw.conversations || raw.chats)) {
      (raw.conversations || raw.chats).forEach((it) => setDetail(ensureId(DSExp.officialToSession(it))));
      loaded.push("ok");
    } else if (Array.isArray(raw)) {
      raw.forEach((it) => {
        const s = fromHistoryDump(it) || (it && (it.messages || it.chat_messages)
          ? DSExp.officialToSession(it) : null);
        if (s) { setDetail(ensureId(s)); loaded.push("ok"); }
      });
    } else {
      const s = fromHistoryDump(raw);
      if (s) { setDetail(ensureId(s)); loaded.push("ok"); }
    }
    if (!loaded.length) { toast("认不出这个 JSON 的结构，请确认是哪种导出文件", true); return; }
    selectedId = order[order.length - 1];
    renderList();
    renderPreview();
    toast("导入完成");
  }

  function importText(text) {
    if (!text.trim()) { toast("先粘贴点内容", true); return; }
    const s = {
      id: "paste-" + Date.now(),
      title: "粘贴的文本",
      updated_at: Math.floor(Date.now() / 1000),
      model_type: "",
      detailReady: true,
      messages: [{ role: "raw", inserted_at: 0, content: text, thinking: "", searches: [] }],
    };
    setDetail(s);
    selectedId = s.id;
    renderList();
    renderPreview();
    toast("已按纯文本导入");
  }

  // ---------------- 提示 ----------------

  let toastTimer = null;
  function toast(msg, sticky) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }
  function setStatus(msg) { $("#stats").textContent = msg; }

  // ---------------- 书签链接生成 ----------------

  async function setupBookmarkletLink() {
    const link = $("#bm-link"), srcBox = $("#bm-code");
    let src = "";
    try { src = await (await fetch("tools/bookmarklet.js")).text(); }
    catch (_) {
      link.style.display = "none";
      srcBox.textContent = "（本地 file:// 打开时读不到源码；部署到 GitHub Pages 后会自动生成。）";
      return;
    }
    srcBox.textContent = src;
    const toolUrl = location.origin + location.pathname;
    const code = src.split("__TOOL_URL__").join(toolUrl);
    link.href = "javascript:" + encodeURIComponent(code);
    link.style.display = "";
  }

  // ---------------- 演示模式 ----------------

  function loadDemo() {
    if (!new URLSearchParams(location.search).has("demo") || !window.DS_DEMO) return;
    window.DS_DEMO.sessions.forEach((s) => { upsertMeta(s); setDetail(s); });
    selectedId = order[0] || null;
    renderList();
    renderPreview();
    setStatus("演示模式：示例数据，导出按钮可直接试用");
  }

  // ---------------- 绑定 ----------------

  $("#btn-all-html").onclick = () => exportAll("html");
  $("#btn-all-txt").onclick = () => exportAll("txt");
  $("#btn-import-json").onclick = () => importJson($("#paste-box").value);
  $("#btn-import-text").onclick = () => importText($("#paste-box").value);
  $("#bm-toggle").onclick = (e) => {
    e.preventDefault();
    const d = $("#bm-details");
    d.hidden = !d.hidden;
  };

  renderList();
  renderPreview();
  loadDemo();
  setupBookmarkletLink();
})();
