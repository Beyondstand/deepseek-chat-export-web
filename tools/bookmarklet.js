/* ============================================================================
 * bookmarklet.js — 「DeepSeek 一键导出」书签脚本源码。
 *
 * 用法：工具网页会自动把 __TOOL_URL__ / __TRIGGERS_JSON__ 替换好并生成可拖拽
 *      的书签链接；也可以手动新建书签，把本文件全部内容粘到「网址 / URL」里
 *      （此时需自行填工具页地址与触发词数组）。
 *
 * 两种能力（点击书签时启动，运行在 chat.deepseek.com 同源环境，无跨域问题）：
 *   A. 全量入库：拉取全部会话推送给工具网页（列表/预览/批量导出）；
 *   B. 聊天内触发：此后在该页面发「导出」等触发词，本轮回答结束后自动
 *      把当前对话导出为 HTML（发「导出txt」则 TXT）并下载、弹确认。
 *      页面整页刷新后 B 失效，再点一次书签即可恢复。
 *
 * token 现读 localStorage，只用于同源请求，不上传、不落盘。
 * ========================================================================== */
(function () {
  "use strict";
  var TOOL_URL = "__TOOL_URL__";           // 工具页地址
  var TRIGGERS = __TRIGGERS_JSON__;        // 触发词数组，如 ["导出","导出txt"]

  /* ---------------- 小工具 ---------------- */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
         + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }
  function sanitize(title) {
    var s = String(title == null ? "" : title).normalize("NFKC").trim()
      .replace(/[\\/:*?"<>|]/g, "_").replace(/[\x00-\x1f]/g, "")
      .replace(/\s+/g, " ").replace(/^\.+/, "").replace(/[. ]+$/, "");
    return (s.slice(0, 40).trim()) || "会话";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------------- 登录态与接口 ---------------- */

  function getToken() {
    try {
      var raw = localStorage.getItem("userToken");
      if (!raw) return null;
      try { var o = JSON.parse(raw); return o.value || o.token || raw; }
      catch (_) { return raw; }
    } catch (_) { return null; }
  }
  var token = getToken();
  if (!token) { alert("未找到登录信息：请先登录 chat.deepseek.com 再点击书签"); return; }

  var origFetch = window.fetch.bind(window);

  function api(path) {
    return origFetch("https://chat.deepseek.com" + path, {
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

  /* ---------------- 归一化（与工具页 shared.js 一致） ---------------- */

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

  /* ---------------- 渲染（与工具页导出同风格） ---------------- */

  var CSS = `
    body{margin:0;background:#f3f4f6;color:#111827;font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7}
    .wrap{max-width:820px;margin:0 auto;padding:24px 16px 64px}
    header.hd{background:linear-gradient(135deg,#0b1220,#1e3a8a);color:#fff;border-radius:14px;padding:22px 24px;margin-bottom:18px}
    header.hd h1{margin:0 0 6px;font-size:20px}
    header.hd .meta{font-size:12.5px;opacity:.85}
    .msg{background:#fff;border:1px solid #e5e7eb;border-left:4px solid #cbd5e1;border-radius:10px;padding:12px 16px;margin:12px 0;white-space:pre-wrap;word-break:break-word}
    .msg.user{border-left-color:#2563eb}
    .msg.ai{border-left-color:#16a34a}
    .who{font-size:12.5px;color:#6b7280;margin-bottom:6px}
    .who time{margin-left:6px}
    .think{margin:6px 0}
    .think summary{cursor:pointer;color:#6b7280;font-size:12.5px}
    .think div{background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:8px 12px;margin-top:6px;color:#475569}
    .refs{font-size:12.5px;color:#6b7280;margin-top:6px}
    .refs ul{margin:4px 0 0 18px;padding:0}
    footer{margin-top:26px;text-align:center;font-size:12px;color:#9ca3af}
  `;

  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
         + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function msgHtml(m) {
    var who = m.role === "user" ? "👤 用户" : "🤖 DeepSeek";
    var h = '<section class="msg ' + (m.role === "user" ? "user" : "ai") + '">';
    h += '<div class="who">' + who + (m.inserted_at ? " <time>" + esc(fmtTime(m.inserted_at)) + "</time>" : "") + "</div>";
    if (m.thinking) {
      h += '<details class="think"><summary>💭 思考过程（点击展开）</summary><div>'
         + esc(m.thinking) + "</div></details>";
    }
    h += '<div class="body">' + esc(m.content || "（空消息）") + "</div>";
    if (m.searches && m.searches.length) {
      h += '<div class="refs">🔍 联网搜索：';
      m.searches.forEach(function (sr) {
        h += "<div>" + esc(sr.query || "未记录关键词");
        (sr.results || []).forEach(function (r) {
          if (r.title || r.url) {
            h += '<ul><li><a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">'
               + esc(r.title || r.url) + "</a></li></ul>";
          }
        });
        h += "</div>";
      });
      h += "</div>";
    }
    return h + "</section>";
  }

  function buildHtml(s) {
    var title = esc(s.title || "(未命名会话)");
    var meta = [
      s.id ? "会话 ID " + esc(s.id) : "",
      "导出时间 " + esc(fmtTime(Math.floor(Date.now() / 1000))),
      (s.messages ? s.messages.length : 0) + " 条消息",
      s.model_type ? "模型 " + esc(s.model_type) : "",
    ].filter(Boolean).join(" · ");
    var body = (s.messages || []).map(msgHtml).join("\n");
    return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + "<title>" + title + " · DeepSeek 对话导出</title>\n"
      + "<style>" + CSS + "</style>\n</head>\n<body>\n<div class=\"wrap\">\n"
      + '<header class="hd"><h1>' + title + '</h1><div class="meta">' + meta + "</div></header>\n"
      + "<main>\n" + body + "\n</main>\n"
      + "<footer>由 DeepSeek 会话导出工具生成 · 非官方 · " + esc(stamp()) + "</footer>\n"
      + "</div>\n</body>\n</html>\n";
  }

  function buildTxt(s) {
    var L = ["DeepSeek 会话记录", "标题：" + (s.title || "(未命名会话)")];
    if (s.id) L.push("会话 ID：" + s.id);
    L.push("导出时间：" + fmtTime(Math.floor(Date.now() / 1000)));
    L.push("消息数：" + (s.messages ? s.messages.length : 0));
    L.push("", "=".repeat(46));
    (s.messages || []).forEach(function (m) {
      L.push("", (m.role === "user" ? "【用户】 " : "【DeepSeek】 ")
        + (m.inserted_at ? fmtTime(m.inserted_at) : ""));
      if (m.thinking) { L.push("（思考过程）", m.thinking, ""); }
      (m.searches || []).forEach(function (sr) {
        L.push("（联网搜索：" + (sr.query || "未记录关键词") + "）");
        (sr.results || []).forEach(function (r) {
          if (r.title || r.url) L.push("  - " + (r.title || "") + " " + (r.url || ""));
        });
        L.push("");
      });
      L.push(m.content || "（空消息）", "");
    });
    L.push("（完）", "");
    return L.join("\n");
  }

  /* ---------------- 下载与页面内确认 ---------------- */

  function download(name, content, mime) {
    var blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function toast(msg, bad) {
    var id = "dsx-bm-toast";
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;"
        + "background:#065f46;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;"
        + "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;"
        + "box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:340px;transition:opacity .5s;";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = bad ? "#7f1d1d" : "#065f46";
    el.style.opacity = "1";
    clearTimeout(el.__hideTimer);
    el.__hideTimer = setTimeout(function () {
      el.style.opacity = "0";
      setTimeout(function () { el.remove(); }, 600);
    }, 6000);
  }

  /* ---------------- B. 聊天内触发（观察发送的消息） ---------------- */

  function matchTrigger(text) {
    var t = String(text == null ? "" : text).trim();
    if (!t) return false;
    var low = t.toLowerCase();
    for (var i = 0; i < TRIGGERS.length; i++) {
      var k = String(TRIGGERS[i]).toLowerCase();
      if (low === k) return true;
      if (low.indexOf(k + " ") === 0 || low.indexOf(k + "，") === 0
        || low.indexOf(k + "。") === 0 || low.indexOf(k + "\n") === 0) return true;
    }
    return false;
  }

  var lastFire = { key: "", at: 0 };

  function exportCurrentChat(prompt, sidFromBody) {
    var sid = sidFromBody || "";
    if (!sid) {
      var m = location.pathname.match(/\/a\/chat\/s\/([^/?\#]+)/);
      sid = m ? m[1] : "";
    }
    if (!sid) { toast("⚠ 找不到当前会话 ID，无法导出", true); return; }
    var fmt = (/(txt|文本)/i.test(prompt)) ? "txt" : "html";
    api("/api/v0/chat/history_messages?chat_session_id=" + encodeURIComponent(sid) + "&cache_version=0")
      .then(function (biz) {
        var s = normalize(biz.chat_session || {}, biz.chat_messages || []);
        if (!s.id) s.id = sid;
        if (!s.title || s.title === "(未命名会话)") s.title = "会话";
        var name = "DeepSeek_" + sanitize(s.title) + "_" + stamp() + "." + fmt;
        download(name, fmt === "html" ? buildHtml(s) : buildTxt(s),
                 fmt === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8");
        toast("✅ 已导出当前对话：" + name + "（" + s.messages.length + " 条消息）");
      })
      .catch(function (e) {
        toast("⚠ 导出失败：" + ((e && e.message) || e), true);
      });
  }

  function onCompletion(body) {
    var prompt = "", sid = "";
    try {
      var j = JSON.parse(body);
      prompt = String(j.prompt || "");
      sid = String(j.chat_session_id || j.session_id || "");
    } catch (_) { return; }
    if (!matchTrigger(prompt)) return;
    var now = Date.now();
    var key = sid + "|" + prompt;
    if (lastFire.key === key && now - lastFire.at < 15000) return;
    lastFire = { key: key, at: now };
    exportCurrentChat(prompt, sid);
  }

  // 只观察：克隆响应读完后照原样返回，不影响页面自己的流式渲染。
  if (!window.__dsBmPatched) {
    window.__dsBmPatched = true;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var isCompletion = url.indexOf("/api/v0/chat/completion") !== -1;
      var body = isCompletion && init && typeof init.body === "string" ? init.body : "";
      return origFetch(input, init).then(function (res) {
        if (isCompletion && body) {
          res.clone().text().catch(function () {}).then(function () {
            try { onCompletion(body); } catch (_) {}
          });
        }
        return res;
      });
    };
  }

  /* ---------------- A. 点击书签：全量会话推送到工具页 ---------------- */

  var popup = window.open(TOOL_URL, "ds-export-web");
  if (!popup) { alert("弹出窗口被浏览器拦截了，请允许本站弹出窗口后重试"); return; }

  var MAX_SESSIONS = 300;
  var PAGE_CAP = 20;

  function push(obj) {
    obj.src = "ds-bm";
    try { popup.postMessage(obj, "*"); } catch (_) {}
  }

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
