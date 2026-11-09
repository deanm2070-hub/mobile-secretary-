// 行動秘書 雲端推播服務（Cloudflare Worker）
// - App 把「未完成事項摘要」與推播訂閱同步到這裡（KV）
// - 每 5 分鐘的排程檢查：到了每日提醒時間、或單項提醒時間，就發 Web Push
// - 推播不帶內容；手機收到後由 sw.js 來 /pending 取通知文字
const SITE = 'https://deanm2070-hub.github.io/mobile-secretary-/';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = s => b64u(new TextEncoder().encode(s));

async function vapidKeys(env) {
  let k = await env.MS_KV.get('vapid', 'json');
  if (k) return k;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  k = { privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey), publicKey: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)) };
  await env.MS_KV.put('vapid', JSON.stringify(k));
  return k;
}

async function sendPush(env, sub) {
  const k = await vapidKeys(env);
  const aud = new URL(sub.endpoint).origin;
  const header = b64uStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64uStr(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE }));
  const key = await crypto.subtle.importKey('jwk', k.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64u(sig)}`;
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', Authorization: `vapid t=${jwt}, k=${k.publicKey}`, 'Content-Length': '0' } });
  return r.status;
}

// 使用者當地時間
function localNow(tzOffsetMin) {
  const d = new Date(Date.now() + tzOffsetMin * 60000);
  const p = n => String(n).padStart(2, '0');
  return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, hm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
}
const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
// 在提醒時間後 2 小時內才補發，避免半夜同步時突然跳出早上的提醒
const due = (hm, target) => { const d = toMin(hm) - toMin(target); return d >= 0 && d < 120; };

function summary(tasks) {
  const mark = { late: '🔴', carry: '🟠', todo: '🔵' };
  const lines = tasks.slice(0, 6).map(t => `${mark[t.st] || '🔵'} ${t.title}`);
  if (tasks.length > 6) lines.push(`…還有 ${tasks.length - 6} 項`);
  return lines.join('\n');
}

async function checkDevice(env, key) {
  const dev = await env.MS_KV.get(key, 'json');
  if (!dev || !dev.sub) return;
  const { date, hm } = localNow(dev.tz || 0);
  const sent = dev.sent && dev.sent.date === date ? dev.sent : { date, keys: [] };
  const msgs = [];
  const tasks = dev.tasks || [];
  if (dev.dailyTime && tasks.length && !sent.keys.includes('daily') && due(hm, dev.dailyTime)) {
    sent.keys.push('daily');
    const carried = tasks.filter(t => t.st !== 'todo').length;
    msgs.push({ title: `📋 今天還有 ${tasks.length} 項未完成`, body: (carried ? `其中 ${carried} 項是之前延續下來的\n` : '') + summary(tasks), tag: 'daily' });
  }
  for (const t of tasks) {
    const k = 't:' + t.id;
    if (t.time && !sent.keys.includes(k) && due(hm, t.time)) {
      sent.keys.push(k);
      msgs.push({ title: '⏰ 該做這件事了', body: t.title + (t.age >= 1 ? `（已延續 ${t.age + 1} 天）` : ''), tag: k });
    }
  }
  if (!msgs.length) return;
  dev.sent = sent;
  dev.queue = [...(dev.queue || []), ...msgs].slice(-10);
  await env.MS_KV.put(key, JSON.stringify(dev));
  // 一次推播即可，手機會把排隊中的通知全部取回顯示
  const status = await sendPush(env, dev.sub);
  if (status === 404 || status === 410) await env.MS_KV.delete(key); // 訂閱已失效
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/vapid') return json({ publicKey: (await vapidKeys(env)).publicKey });
    if (url.pathname === '/sync' && req.method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b || !/^[a-z0-9]{8,40}$/.test(b.id || '')) return json({ error: 'bad request' }, 400);
      const key = 'dev:' + b.id;
      const old = (await env.MS_KV.get(key, 'json')) || {};
      const dev = {
        ...old,
        sub: b.sub || old.sub || null,
        tz: Number(b.tz) || 0,
        dailyTime: /^\d\d:\d\d$/.test(b.dailyTime || '') ? b.dailyTime : '09:00',
        tasks: (b.tasks || []).slice(0, 200).map(t => ({ id: String(t.id).slice(0, 40), title: String(t.title).slice(0, 120), st: t.st, age: Number(t.age) || 0, time: /^\d\d:\d\d$/.test(t.time || '') ? t.time : '' })),
        updated: Date.now(),
      };
      await env.MS_KV.put(key, JSON.stringify(dev));
      return json({ ok: true });
    }
    if (url.pathname === '/pending') {
      const key = 'dev:' + (url.searchParams.get('id') || '');
      const dev = await env.MS_KV.get(key, 'json');
      const queue = (dev && dev.queue) || [];
      if (dev && queue.length) { dev.queue = []; await env.MS_KV.put(key, JSON.stringify(dev)); }
      return json({ messages: queue });
    }
    if (url.pathname === '/test' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const key = 'dev:' + (b.id || '');
      const dev = await env.MS_KV.get(key, 'json');
      if (!dev || !dev.sub) return json({ error: '找不到這台裝置的訂閱' }, 404);
      dev.queue = [...(dev.queue || []), { title: '✅ 雲端推播測試成功', body: '之後 App 沒開也會準時提醒你', tag: 'test' }];
      await env.MS_KV.put(key, JSON.stringify(dev));
      return json({ status: await sendPush(env, dev.sub) });
    }
    return json({ ok: true, service: '行動秘書推播' });
  },
  async scheduled(event, env, ctx) {
    let cursor;
    do {
      const list = await env.MS_KV.list({ prefix: 'dev:', cursor });
      for (const k of list.keys) ctx.waitUntil(checkDevice(env, k.name).catch(e => console.log('device error', k.name, e)));
      cursor = list.list_complete ? null : list.cursor;
    } while (cursor);
  },
};
