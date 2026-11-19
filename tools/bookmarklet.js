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
  var TRIGGERS = __TRIGGERS_JSON__;        // 触发词数组，如 ["导出","导出txt","导出链接"]
  var WORKER_URL = "__WORKER_URL__";       // 可选：自建「读完即删」Worker；留空则用公共 TXT 临时服务
  var HINT = __HINT_JSON__;                // true=发触发词时自动向模型附注「已导出」状态

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

  /* ---------------- 在线查看链接（仅当触发词含「链接/分享」时才调用） ---------------- */

  /** 公共方案：tmpfiles.org（TXT，60 分钟有效；免费服务禁止 HTML 类型） */
  function uploadTmpfiles(text) {
    var fd = new FormData();
    fd.append("file", new Blob([text], { type: "text/plain" }),
              "deepseek-" + stamp() + ".txt");
    return fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: fd })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (o) {
        if (!o.ok || !o.j || o.j.status !== "success" || !o.j.data || !o.j.data.url)
          throw new Error((o.j && o.j.message) || "上传失败");
        return o.j.data.url.replace(".org/", ".org/dl/"); // 换成直链，模型/浏览器都能读
      });
  }

  /** 自建方案：Cloudflare Worker（HTML，被读取一次后自动删除） */
  function uploadWorker(html) {
    return fetch(WORKER_URL.replace(/\/+$/, "") + "/up", { method: "POST", body: html })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (o) {
        if (!o.ok || !o.j || !o.j.ok || !o.j.url) throw new Error("Worker 上传失败");
        return o.j.url;
      });
  }

  function copyText(t) {
    try { if (navigator.clipboard) navigator.clipboard.writeText(t).catch(function () {}); } catch (_) {}
  }

  function makeLink(htmlContent, txtContent, fmt) {
    var worker = fmt === "html" && WORKER_URL;
    var task = worker ? uploadWorker(htmlContent) : uploadTmpfiles(txtContent);
    task.then(function (u) {
      toast((fmt === "html" && WORKER_URL)
        ? "🔗 在线查看链接（被读取一次后自动删除）：\n" + u
        : "🔗 在线查看链接（纯文本 · 60 分钟内有效）：\n" + u);
      copyText(u);
    }).catch(function (e) {
      toast("⚠ 链接生成失败：" + ((e && e.message) || e), true);
    });
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
        + "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;white-space:pre-line;"
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
      if (low.indexOf(k) === 0) return true; // 以触发词开头即触发（可跟自然语言补充说明）
    }
    return false;
  }

  var HINT_MARK = "【系统附注";

  /** 发触发词时，在消息里附注一句「已导出」状态，让模型的回复与事实一致、列出后续步骤 */
  function appendHint(body) {
    var j;
    try { j = JSON.parse(body); } catch (_) { return body; }
    if (!j || typeof j.prompt !== "string") return body;
    if (!matchTrigger(j.prompt)) return body;
    if (j.prompt.indexOf(HINT_MARK) !== -1) return body;
    j.prompt = j.prompt + "\n\n" + HINT_MARK + "（由导出工具添加）】本轮对话已通过浏览器脚本自动导出为本地文件"
      + "（HTML/TXT，位于浏览器下载目录）。请在回复中：① 简要确认导出已完成；"
      + "② 用 2~3 条列出用户接下来可以做的操作（如打开下载的 HTML、发送「导出链接」获取临时在线链接、发送「导出txt」换纯文本）。"
      + "不要编造未发生的事实。";
    return JSON.stringify(j);
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
    var wantLink = /(链接|分享|share)/i.test(prompt);
    api("/api/v0/chat/history_messages?chat_session_id=" + encodeURIComponent(sid) + "&cache_version=0")
      .then(function (biz) {
        var s = normalize(biz.chat_session || {}, biz.chat_messages || []);
        if (!s.id) s.id = sid;
        if (!s.title || s.title === "(未命名会话)") s.title = "会话";
        var content = fmt === "html" ? buildHtml(s) : buildTxt(s);
        var name = "DeepSeek_" + sanitize(s.title) + "_" + stamp() + "." + fmt;
        download(name, content,
                 fmt === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8");
        toast("✅ 已导出当前对话：" + name + "（" + s.messages.length + " 条消息）");
        if (wantLink) makeLink(content, buildTxt(s), fmt);
      })
      .catch(function (e) {
        toast("⚠ 导出失败：" + ((e && e.message) || e), true);
      });
  }

  // ---- 诊断徽章：实时显示监听器捕获情况（点一下可隐藏） ----
  var capCount = 0;
  function chip(text) {
    var c = document.getElementById("dsx-chip");
    if (!c) {
      c = document.createElement("div");
      c.id = "dsx-chip";
      c.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;"
        + "background:#111827;color:#e5e7eb;border-radius:8px;padding:6px 10px;font-size:11px;"
        + "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;opacity:.9;cursor:pointer;"
        + "max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        + "box-shadow:0 2px 10px rgba(0,0,0,.35)";
      c.title = "DeepSeek 导出监听状态（点击隐藏）";
      c.onclick = function () { c.remove(); };
      document.body.appendChild(c);
    }
    c.textContent = text;
  }

  /** 从请求体抽取 prompt（不依赖完整 JSON 结构，端点/字段变动也能工作） */
  function extractPrompt(body) {
    var m = String(body).match(/"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    try { return JSON.parse('"' + m[1] + '"'); } catch (_) { return m[1]; }
  }

  /** 任何 /api/v0/ 的 POST，只要请求体带 prompt 字段就视为「用户发消息」 */
  function handleSend(body, transport) {
    if (!body) return;
    var prompt = extractPrompt(body) || "";
    var sid = "";
    var sm = String(body).match(/"chat_session_id"\s*:\s*"([^"]*)"/);
    if (sm) sid = sm[1];
    capCount++;
    chip("ds导出 · 捕获#" + capCount + " via " + transport + " · "
      + (prompt ? "prompt=" + prompt.slice(0, 16) : "无prompt字段"));
    if (!prompt || !matchTrigger(prompt)) return;
    var now = Date.now();
    var key = sid + "|" + prompt;
    if (lastFire.key === key && now - lastFire.at < 15000) return;
    lastFire = { key: key, at: now };
    exportCurrentChat(prompt, sid);
  }

  // 只观察：请求发出后照原样进行，不影响页面自己的逻辑与流式渲染。
  // 判定放宽：/api/v0/ 下的请求体含 "prompt" 字段即视为发消息（不锁定具体端点名）。
  if (!window.__dsBmPatched) {
    window.__dsBmPatched = true;

    // --- fetch ---
    window.fetch = async function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var isV0 = url.indexOf("/api/v0/") !== -1;
      var body = isV0 && init && typeof init.body === "string" ? init.body : "";
      var reqObj = null;
      if (isV0 && !body && typeof Request !== "undefined" && input instanceof Request) {
        try { body = await input.clone().text(); } catch (_) {}
        reqObj = input;
      }
      if (body && /"prompt"\s*:/.test(body)) {
        if (HINT) {
          var hinted = appendHint(body);
          if (hinted !== body) {
            if (reqObj) { try { input = new Request(reqObj, { body: hinted }); } catch (_) {} }
            else { init = Object.assign({}, init || {}, { body: hinted }); }
            body = hinted;
          }
        }
        var res = await origFetch(input, init);
        res.clone().text().catch(function () {}).then(function () {
          try { handleSend(body, "fetch"); } catch (_) {}
        });
        return res;
      }
      return origFetch(input, init);
    };

    // --- XMLHttpRequest ---
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__dsUrl = String(url || "");
      this.__dsMethod = String(method || "").toUpperCase();
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;
      var isV0 = (xhr.__dsUrl || "").indexOf("/api/v0/") !== -1;
      if (isV0 && typeof body === "string" && /"prompt"\s*:/.test(body)) {
        if (HINT) {
          try {
            var hinted = appendHint(body);
            if (hinted !== body) body = hinted;
          } catch (_) {}
        }
        xhr.addEventListener("loadend", function () {
          try { handleSend(body, "XHR"); } catch (_) {}
        });
      }
      return origSend.call(this, body);
    };

    // 诊断信号：确认监听已装好（若看不到，说明书签没在 DeepSeek 页面生效）
    chip("ds导出 · 监听中（发消息后这里显示捕获计数）");
    toast("✅ 导出监听已开启：发送「导出」即可自动保存（本页面整页刷新后需再点一次书签）");
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
