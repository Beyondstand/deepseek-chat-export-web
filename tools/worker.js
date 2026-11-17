/* ============================================================================
 * one-shot-viewer Worker —— 「在线查看链接，被读取一次后自动删除」
 *
 * 接口：
 *   POST /up          请求体为 HTML 文本 → 返回 { ok, url }
 *   GET  /<id>        返回 HTML，并立即删除（读一次即删；KV 另有 1 小时兜底过期）
 *
 * 部署（一次性，约 3 分钟，需自己的 Cloudflare 账号）：
 *   1. dash.cloudflare.com → Workers & Pages → 创建 Worker → 粘贴本文件全部内容 → 部署；
 *   2. 该 Worker → 设置 → 变量 → 绑定 KV 命名空间（名称必须为 FILES，建一个空命名空间即可）；
 *   3. 把 Worker 地址（https://xxx.workers.dev）填进工具页的「在线链接 Worker 地址」输入框。
 *
 * 说明：上传不需要鉴权（链接即钥匙，id 为 32 位随机串不可枚举）；
 *      如需私有，可在 POST /up 前加一层自己的校验。
 * ========================================================================== */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    if (req.method === "POST" && url.pathname.endsWith("/up")) {
      const html = await req.text();
      if (!html || html.length < 10) {
        return Response.json({ ok: false, error: "empty" }, { status: 400, headers: cors });
      }
      if (html.length > 2000000) {
        return Response.json({ ok: false, error: "too large (>2MB)" }, { status: 413, headers: cors });
      }
      const id = crypto.randomUUID().replaceAll("-", "");
      await env.FILES.put(id, html, { expirationTtl: 3600 });
      return Response.json({ ok: true, url: url.origin + "/" + id }, { headers: cors });
    }

    if (req.method === "GET" && url.pathname.length > 1) {
      const id = url.pathname.slice(1).split("/")[0];
      const html = await env.FILES.get(id);
      if (html == null) {
        return new Response("Not found（可能已被读取并删除，或已过期）", { status: 404, headers: cors });
      }
      await env.FILES.delete(id);
      return new Response(html, {
        headers: Object.assign({}, cors, {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-store",
        }),
      });
    }

    return new Response("deepseek one-shot viewer", { headers: cors });
  },
};
