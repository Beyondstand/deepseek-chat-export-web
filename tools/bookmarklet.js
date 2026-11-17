/* ============================================================================
 * bookmarklet.js — 「DeepSeek 一键导出」书签脚本源码。
 *
 * 用法：工具网页会自动把 __TOOL_URL__ 替换成本页地址并生成可拖拽的书签链接；
 *      也可以手动新建书签，把本文件全部内容粘到「网址 / URL」里。
 *
 * 原理：书签脚本运行在 chat.deepseek.com 页面里（同源），所以不受跨域限制：
 *   ① 现读 localStorage 里的登录 token（用户无需手工复制粘贴）；
 *   ② 调只读接口拉取会话列表和全部消息；
 *   ③ 通过 postMessage 把数据推给工具网页（重发列表直到收到回执，保证送达）。
 *   token 全程只存在于这个 DeepSeek 标签页内，不上传、不落盘。
 * ========================================================================== */
(function () {
  "use strict";
  var TOOL_URL = "__TOOL_URL__"; // 工具页地址（形如 https://you.github.io/repo/）

  var token = "";
  try {
    var raw = localStorage.getItem("userToken");
    if (raw) {
      try { var o = JSON.parse(raw); token = o.value || o.token || raw; }
      catch (_) { token = raw; }
    }
  } catch (_) {}
  if (!token) { alert("未找到登录信息：请先登录 chat.deepseek.com 再点击书签"); return; }

  var popup = window.open(TOOL_URL, "ds-export-web");
  if (!popup) { alert("弹出窗口被浏览器拦截了，请允许本站弹出窗口后重试"); return; }

  var MAX_SESSIONS = 300; // 最多导出的会话数
  var PAGE_CAP = 20;      // 会话列表最多翻 20 页

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function api(path) {
    return fetch("https://chat.deepseek.com" + path, {
      credentials: "include",
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "x-client-platform": "web",
        "x-client-version": "2.8.0",
        "x-client-locale": "zh_CN",
      },
    }).then(function (res) {
      return res.json().catch(function () { return {}; });
    }).then(function (j) {
      if (j.code !== 0) {
        if (j.code === 40003 || j.msg === "INVALID_TOKEN") {
          throw new Error("登录已失效：请刷新 DeepSeek 页面重新登录后再点书签");
        }
        throw new Error("接口错误 code=" + j.code + " " + (j.msg || ""));
      }
      return (j.data && j.data.biz_data) || {};
    });
  }

  function push(obj) {
    obj.src = "ds-bm";
    try { popup.postMessage(obj, "*"); } catch (_) {}
  }

  /* ---------------- 归一化（自包含；与工具页 shared.js 逻辑一致） ---------------- */

  function idOf(m) {
    if (!m) return null;
    var v = (m.message_id !== undefined && m.message_id !== null) ? m.message_id : m.id;
    return (v === undefined || v === null) ? null : String(v);
  }

  function normalize(cs, msgs) {
    cs = cs || {};
    msgs = msgs || [];
    var byId = {}, id, i;
    for (i = 0; i < msgs.length; i++) { id = idOf(msgs[i]); if (id !== null) byId[id] = msgs[i]; }

    // 只保留当前可见分支（current_message_id 沿 parent_id 回溯）
    var keep = null;
    if (cs.current_message_id !== undefined && cs.current_message_id !== null) {
      keep = {};
      var cur = byId[String(cs.current_message_id)], guard = 0;
      while (cur && guard++ <= msgs.length + 1) {
        id = idOf(cur);
        if (id === null) break;
        keep[id] = true;
        var p = cur.parent_id;
        cur = (p === undefined || p === null) ? null : byId[String(p)];
      }
    }

    var out = [];
    for (i = 0; i < msgs.length; i++) {
      id = idOf(msgs[i]);
      if (keep && (id === null || !keep[id])) continue;
      out.push(extract(msgs[i]));
    }
    out.sort(function (a, b) { return a.inserted_at - b.inserted_at; });
    return {
      id: String(cs.id || ""),
      title: cs.title || "(未命名会话)",
      updated_at: cs.updated_at || 0,
      model_type: cs.model_type || "",
      messages: out,
    };
  }

  function extract(m) {
    var role = String(m.role || "").toUpperCase() === "USER" ? "user" : "assistant";
    var cp = [], tp = [], ss = [];
    (m.fragments || []).forEach(function (f) {
      var t = String(f.type || "").toUpperCase(), c = f.content || "";
      if (t === "REQUEST" || t === "RESPONSE") { if (c) cp.push(c); }
      else if (t === "THINK") { if (c) tp.push(c); }
      else if (t === "TOOL_SEARCH") {
        ss.push({
          query: (f.queries || []).join(", "),
          results: (f.results || []).map(function (r) { return { title: r.title || "", url: r.url || "" }; }),
        });
      }
    });
    if (!cp.length && typeof m.content === "string") cp.push(m.content);
    if (!tp.length && typeof m.thinking_content === "string") tp.push(m.thinking_content);
    return {
      role: role,
      inserted_at: m.inserted_at || m.created_at || 0,
      content: cp.join("\n\n").trim(),
      thinking: tp.join("\n\n").trim(),
      searches: ss,
    };
  }

  /* ---------------- 握手 + 主流程 ---------------- */

  var acked = false;
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (d && d.src === "ds-page" && d.type === "ack") acked = true;
  });

  var metas = [];
  var retryTimes = 0;
  var listTimer = setInterval(function () {
    if (acked || retryTimes >= 90) { clearInterval(listTimer); return; }
    retryTimes++;
    push({ type: "list", sessions: metas });
  }, 400);

  (async function () {
    try {
      // 1) 会话列表（lte_cursor 关键字游标翻页）
      var all = [], cur = null;
      for (var p = 0; p < PAGE_CAP; p++) {
        var qs = "/api/v0/chat_session/fetch_page?count=100&lte_cursor.pinned=false";
        if (cur) qs += "&lte_cursor.updated_at=" + cur.updated_at
                      + "&lte_cursor.id=" + encodeURIComponent(cur.id);
        var biz = await api(qs);
        var items = biz.chat_sessions || [];
        items.forEach(function (m) { all.push(m); });
        if (!biz.has_more || !items.length) break;
        cur = items[items.length - 1];
        await sleep(300);
      }
      metas = all.slice(0, MAX_SESSIONS);
      push({ type: "list", sessions: metas });

      // 2) 逐个拉详情推送（节流 350ms，避免触发频控）
      var got = 0;
      for (var i = 0; i < metas.length; i++) {
        try {
          var h = await api("/api/v0/chat/history_messages?chat_session_id="
                            + encodeURIComponent(metas[i].id) + "&cache_version=0");
          var s = normalize(h.chat_session || {}, h.chat_messages || []);
          if (!s.id) s.id = metas[i].id;
          push({ type: "detail", session: s });
          got++;
          if (i % 5 === 0) push({ type: "progress", got: got, total: metas.length });
        } catch (_) { /* 单个会话失败就跳过 */ }
        await sleep(350);
      }
      push({ type: "progress", got: metas.length, total: metas.length });
    } catch (e) {
      push({ type: "error", message: (e && e.message) || String(e) });
    }
  })();
})();
