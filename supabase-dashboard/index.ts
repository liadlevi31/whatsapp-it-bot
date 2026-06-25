// =============================================================================
// Live SLA Dashboard (Supabase Edge Function) for the whatsapp-web.js bot
// =============================================================================
// Hosted on Supabase — accessible from any browser, no separate host needed.
// Reads the 'chats' table the bot writes to. Password-protected (Basic Auth).
// Shows 'human' tickets with a live 4-hour SLA countdown (flashes red < 1h),
// and a Resolve button that closes the chat.
// Auto env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional secrets: DASHBOARD_USER, DASHBOARD_PASSWORD.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const DEFAULT_USER = 'admin';
const DEFAULT_PASSWORD = 'Tickets-9fK2-Lm74';
const SLA_MS = 4 * 60 * 60 * 1000;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL'),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll(String.fromCharCode(39), '&#39;');
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function checkAuth(req) {
  const h = req.headers.get('authorization');
  if (!h || !h.startsWith('Basic ')) return false;
  let dec = '';
  try { dec = atob(h.slice(6)); } catch { return false; }
  const i = dec.indexOf(':');
  if (i < 0) return false;
  return safeEqual(dec.slice(0, i), Deno.env.get('DASHBOARD_USER') || DEFAULT_USER) &&
         safeEqual(dec.slice(i + 1), Deno.env.get('DASHBOARD_PASSWORD') || DEFAULT_PASSWORD);
}
function unauthorized() {
  return new Response('Authentication required', {
    status: 401, headers: { 'WWW-Authenticate': 'Basic realm=SLA-Dashboard' },
  });
}

const STYLE = [
  '*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a}',
  '.wrap{max-width:980px;margin:0 auto;padding:24px}h1{font-size:22px;margin:0 0 2px}',
  '.sub{color:#64748b;font-size:13px;margin-bottom:18px}',
  'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}',
  'th,td{text-align:left;padding:11px 14px;font-size:14px;border-bottom:1px solid #f1f5f9}',
  'th{background:#f8fafc;color:#64748b;font-size:11px;text-transform:uppercase}',
  'tr:last-child td{border-bottom:none}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}',
  '.timer{font-variant-numeric:tabular-nums;font-weight:700}',
  '.btn{border:0;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;background:#059669;color:#fff}',
  '.empty{text-align:center;color:#94a3b8;padding:42px}',
  '@keyframes fr{0%,100%{background:#fee2e2}50%{background:#fecaca}}.flash{animation:fr 1s ease-in-out infinite}',
].join('');

Deno.serve(async (req) => {
  if (!checkAuth(req)) return unauthorized();
  const url = new URL(req.url);

  // Resolve action -> close the chat, redirect back (Post/Redirect/Get).
  if (req.method === 'POST') {
    const form = await req.formData();
    const phone = String(form.get('phone_number') || '');
    const action = String(form.get('action') || 'closed');
    const next = action === 'bot' ? 'bot' : 'closed';
    if (phone) {
      await supabase.from('chats').update({ status: next, updated_at: new Date().toISOString() })
        .eq('phone_number', phone);
    }
    return new Response(null, { status: 303, headers: { Location: './supabase-dashboard' } });
  }

  const { data, error } = await supabase.from('chats').select('*')
    .eq('status', 'human').order('sla_start', { ascending: true });
  const rows = data || [];

  let body;
  if (error) {
    body = '<div class=empty>Error loading chats: ' + esc(error.message) + '</div>';
  } else if (!rows.length) {
    body = '<div class=empty>No active human tickets. &#127881;</div>';
  } else {
    let trs = '';
    for (const r of rows) {
      const phone = String(r.phone_number || '').replace('@c.us', '');
      const sla = r.sla_start ? new Date(r.sla_start).getTime() : 0;
      trs += '<tr data-end="' + (sla ? sla + SLA_MS : 0) + '">' +
        '<td class=mono>' + esc(phone) + '</td>' +
        '<td>' + esc(r.last_message || '') + '</td>' +
        '<td><span class=timer>--:--:--</span></td>' +
        '<td><form method=POST><input type=hidden name=phone_number value="' + esc(r.phone_number) +
        '"><input type=hidden name=action value=closed><button class=btn type=submit>Resolve</button></form></td>' +
        '</tr>';
    }
    body = '<table><thead><tr><th>Phone</th><th>Last message</th><th>SLA remaining</th><th>Action</th></tr></thead><tbody>' +
      trs + '</tbody></table>';
  }

  const html = '<!doctype html><html lang=en><head><meta charset=utf-8>' +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    '<meta http-equiv=refresh content=15>' +   // refresh list every 15s to catch new/closed tickets
    '<title>Live SLA Dashboard</title><style>' + STYLE + '</style></head><body><div class=wrap>' +
    '<h1>IT Support &mdash; Live Tickets</h1><div class=sub>Open human tickets &middot; 4-hour SLA &middot; auto-refresh 15s</div>' +
    body + '</div><script>' +
    '(function(){function pad(n){return (n<10?"0":"")+n;}' +
    'function tick(){var rows=document.querySelectorAll("tr[data-end]");for(var i=0;i<rows.length;i++){' +
    'var end=parseInt(rows[i].getAttribute("data-end"),10);var sp=rows[i].querySelector(".timer");if(!end){sp.textContent="--";continue;}' +
    'var ms=end-Date.now();if(ms<=0){sp.textContent="SLA BREACHED";sp.style.color="#dc2626";rows[i].classList.add("flash");continue;}' +
    'var h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000);' +
    'sp.textContent=pad(h)+":"+pad(m)+":"+pad(s);' +
    'if(ms<3600000){sp.style.color="#dc2626";rows[i].classList.add("flash");}else{sp.style.color="#0f172a";rows[i].classList.remove("flash");}}}' +
    'tick();setInterval(tick,1000);})();' +
    '</script></body></html>';

  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});
