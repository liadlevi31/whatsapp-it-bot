/**
 * =============================================================================
 *  IT Support Desk - WhatsApp bot + live chat ticket dashboard
 *  whatsapp-web.js + Supabase + Express
 * =============================================================================
 *  Flow:
 *   - First message from a new contact -> greeting with numbered menu + ticket
 *     (status 'received'). The bot helps via AI (Gemini) or hardcoded topics.
 *   - When an agent replies from the dashboard, the ticket goes 'in_progress',
 *     the SLA timer pauses, and the bot stays silent so the human can talk.
 *   - 'closed' ends it; a new message later starts a fresh ticket.
 *  Dashboard (login-protected, server-rendered): ticket board with statuses,
 *  and a chat window per ticket to read history and reply to the customer.
 *
 *  ENV: SUPABASE_URL, SUPABASE_KEY (required); GEMINI_API_KEY (recommended);
 *       DASHBOARD_USER, DASHBOARD_PASSWORD, PORT, WWEBJS_AUTH_PATH,
 *       PUPPETEER_EXECUTABLE_PATH (optional).
 * =============================================================================
 */

require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;
const SLA_MS = 4 * 60 * 60 * 1000;
const DASH_USER = process.env.DASHBOARD_USER || 'admin';
const DASH_PASS = process.env.DASHBOARD_PASSWORD || 'ChangeMe-8842';

// ---------------------------------------------------------------------------
//  Bot messages
// ---------------------------------------------------------------------------

// Greeting shown on first contact — includes the numbered menu
const GREETING = 'Hey \u{1F44B}\n' +
  'Your ticket has been received and we\'ll get back to you within 4 hours.\n\n' +
  'Meanwhile, I\'m your AI Tier-1 IT assistant. What seems to be the problem?\n' +
  'You can just describe the issue (e.g., "my laptop won\'t turn on", "I can\'t login to Zoom", etc.) and I\'ll try to help!';

// Shortened menu for follow-up prompts
const MENU = 'What else can I help with? Just describe the issue.';

const TOPICS = {
  mac: "For macOS issues (slow, frozen): Press Cmd+Opt+Esc to force-quit, check free storage, or restart. For 'won't turn on', ask them to check the power cable and hold the power button for 10 seconds.",
  wifi: "For WiFi/Internet: Turn WiFi off and on, forget the network and rejoin, or restart the router.",
  email: "For Gmail/Calendar: Check internet connection, sign out and back in, ensure they are using their company Google Workspace account.",
  software: "For Gong, Monday, Zoom, Adobe: Click 'Continue with Google' to use SSO, or try an Incognito window to clear cache/conflicts."
};

function parseTopic(s) {
  if (/(^|\s)1(\s|$|\.|\))/.test(s) || /\b(wifi|wi-fi|internet|network|connection)\b/.test(s)) return 'wifi';
  if (/(^|\s)2(\s|$|\.|\))/.test(s) || /\b(password|login|log in|2fa|authenticator|sign in|code)\b/.test(s)) return 'password';
  if (/(^|\s)3(\s|$|\.|\))/.test(s) || /\b(email|e-mail|gmail|outlook|mail)\b/.test(s)) return 'email';
  if (/(^|\s)4(\s|$|\.|\))/.test(s) || /\b(printer|print|printing)\b/.test(s)) return 'printer';
  if (/(^|\s)5(\s|$|\.|\))/.test(s) || /\b(mac|computer|laptop|slow|frozen|freeze|stuck|spinning)\b/.test(s)) return 'mac';
  if (/(^|\s)6(\s|$|\.|\))/.test(s) || /\b(software|app|zoom|adobe|gong|monday|sso|teams|slack)\b/.test(s)) return 'software';
  if (/(^|\s)7(\s|$|\.|\))/.test(s) || /\b(other|something else|else)\b/.test(s)) return 'other';
  return null;
}

// ---------------------------------------------------------------------------
//  Gemini AI brain (Google Generative AI API)
//  Falls back to numbered-menu topics + FAQ if absent or failing.
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODELS = process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
const GEMINI_TIMEOUT_MS = 15000; // 15s — generous but prevents infinite hangs

const AI_SYSTEM =
  "You are an expert, friendly IT Tier 1 Support Agent for our company, chatting with employees over WhatsApp. Your goal is to troubleshoot basic IT issues before escalating to a senior admin.\n" +
  "When the user describes an issue, use these guidelines to help them:\n" +
  Object.values(TOPICS).map(function(t) { return "- " + t; }).join('\n') + "\n" +
  "If the issue is not explicitly listed, use your general IT knowledge to provide 1 or 2 practical troubleshooting steps.\n" +
  "Give short, conversational, step-by-step help \u2014 2 to 4 sentences max. Use plain text only (no markdown, no bold asterisks, no bullet symbols).\n" +
  "Ask one follow-up question at a time if you need more detail, or ask if the steps fixed it.\n" +
  "If the user replies YES (solved), congratulate them briefly.\n" +
  "If the user explicitly asks for a human, or if basic troubleshooting fails, tell them: 'I've escalated your ticket to our senior IT team. They will reach out within our 4-hour SLA.'\n" +
  "Do not escalate immediately unless they ask for it or it's a critical hardware failure.\n" +
  "Never invent company-specific details, passwords, or links. Keep responses under 200 words.";

let geminiModel = null; // cached working model id

/**
 * Call the Gemini generateContent endpoint with conversation history.
 * Tries each model in GEMINI_MODELS until one succeeds.
 * Returns the generated text, or null on failure (caller falls back to menu).
 */
async function callGemini(history) {
  if (!GEMINI_API_KEY) return null;

  const contents = (history || []).map(function (m) {
    return { role: m.direction === 'inbound' ? 'user' : 'model', parts: [{ text: String(m.content || '') }] };
  });
  if (!contents.length) return null;

  // Gemini requires the conversation to start with a 'user' turn.
  // If it starts with 'model' (e.g. the bot greeting was logged first), prepend a dummy user turn.
  if (contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '(conversation start)' }] });
  }

  const body = {
    systemInstruction: { parts: [{ text: AI_SYSTEM }] },
    contents: contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 400 }
  };

  const candidates = geminiModel ? [geminiModel] : GEMINI_MODELS;

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, GEMINI_TIMEOUT_MS);

    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent?key=' + GEMINI_API_KEY;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        // Log the first successful model discovery
        if (!geminiModel) console.log('[gemini] \u2705 using model: ' + m);
        geminiModel = m;

        const data = await res.json();
        const t = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
        const text = (t || '').trim();
        return text || null;
      }

      const errTxt = await res.text().catch(function () { return ''; });
      console.error('[gemini] ' + m + ' HTTP ' + res.status + ': ' + errTxt.slice(0, 200));

      // 429 = quota/rate limit -> stop trying other models, fall back to menu
      if (res.status === 429) return null;
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        console.error('[gemini] ' + m + ' timed out after ' + GEMINI_TIMEOUT_MS + 'ms');
      } else {
        console.error('[gemini] ' + m + ' error: ' + (e && e.message));
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
//  assistantReply — AI with conversation context, then fallbacks
// ---------------------------------------------------------------------------
async function assistantReply(msg, from, text, chat) {
  var lower = String(text || '').toLowerCase();
  var trimmed = String(text || '').trim();

  // Fast-path removed. We rely fully on Gemini to handle the conversation naturally.

  // 1. Try Gemini AI first (with full conversation history for context)
  if (GEMINI_API_KEY) {
    var query = supabase.from('chat_messages').select('direction, content').eq('phone_number', from);
    if (chat && chat.sla_start) query = query.gte('created_at', chat.sla_start);
    var result = await query.order('created_at', { ascending: true }).limit(30);
    var hist = result.data;
    var ai = await callGemini(hist && hist.length ? hist : [{ direction: 'inbound', content: text }]);
    if (ai) { 
      await botReply(msg, from, ai); 
      if (/escalat/i.test(ai) || /4-hour SLA/i.test(ai) || /passed your ticket/i.test(ai)) {
        await supabase.from('chats').update({ bot_stage: 'escalated', updated_at: new Date().toISOString() }).eq('phone_number', from);
      }
      return; 
    }
    console.log('[assistant] Gemini returned null, falling back to topic/FAQ/menu');
  }

  // 2. Fallback: match numbered menu selection or keywords to hardcoded topics
  var topic = parseTopic(lower);
  if (topic === 'other') {
    await botReply(msg, from, "Got it \u2014 I've passed your request to our IT team. They'll reach you within 4 hours. \u{1F64C}");
    await supabase.from('chats').update({ bot_stage: 'escalated', updated_at: new Date().toISOString() }).eq('phone_number', from);
    return;
  }
  if (topic && TOPICS[topic]) {
    await botReply(msg, from, TOPICS[topic]);
    return;
  }

  // 3. Fallback: FAQ keyword match from Supabase
  var faqResult = await supabase.from('faq').select('keyword, answer');
  var ans = faqAnswer(faqResult.data, lower);
  if (ans) { await botReply(msg, from, ans); return; }

  // 4. Nothing matched — show the menu again
  await botReply(msg, from, MENU);
}

// ---------------------------------------------------------------------------
//  Utilities
// ---------------------------------------------------------------------------
function banner(msg) {
  var line = '='.repeat(74);
  console.error('\n' + line + '\n  ' + String(msg).split('\n').join('\n  ') + '\n' + line + '\n');
}

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

async function selfCheck() {
  var missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY) missing.push('SUPABASE_KEY');
  if (missing.length) { banner('FATAL: missing env: ' + missing.join(', ')); process.exit(1); }

  for (var t of ['chats', 'faq', 'chat_messages']) {
    var check = await supabase.from(t).select('*').limit(1);
    if (check.error) { banner('FATAL: Supabase check failed on "' + t + '": ' + (check.error.message || check.error.code)); process.exit(1); }
  }
  console.log('[OK] Supabase connected \u2014 all tables verified.');

  if (GEMINI_API_KEY) {
    console.log('[OK] GEMINI_API_KEY configured \u2014 AI replies enabled.');
    // Quick validation: try a tiny request to confirm the key works
    try {
      var testModel = GEMINI_MODELS[0];
      var testUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + testModel + ':generateContent?key=' + GEMINI_API_KEY;
      var testRes = await fetch(testUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
          generationConfig: { maxOutputTokens: 5 }
        })
      });
      if (testRes.ok) {
        console.log('[OK] Gemini API key validated \u2014 model ' + testModel + ' responds.');
        geminiModel = testModel;
      } else {
        var errBody = await testRes.text().catch(function () { return ''; });
        console.warn('[WARN] Gemini test call failed (HTTP ' + testRes.status + '): ' + errBody.slice(0, 150));
        console.warn('[WARN] AI replies may not work. Will try fallback models at runtime.');
      }
    } catch (e) {
      console.warn('[WARN] Gemini test call error: ' + (e && e.message) + ' \u2014 AI replies may not work.');
    }
  } else {
    console.log('[INFO] No GEMINI_API_KEY set \u2014 using numbered menu + FAQ fallback only.');
  }
}

// ---------------------------------------------------------------------------
//  WhatsApp state + helpers
// ---------------------------------------------------------------------------
var wa = { connected: false, qr: null };
var waClient = null;

async function logMsg(phone, direction, content) {
  try { await supabase.from('chat_messages').insert({ phone_number: phone, direction, content }); }
  catch (e) { console.error('[logMsg]', e && e.message); }
}

// Robust outbound send (used by both the bot and the dashboard agent replies).
async function sendText(phone, text) {
  try {
    if (waClient) await waClient.sendMessage(phone, text);
    await logMsg(phone, 'outbound', text);
    return true;
  } catch (e) { console.error('[sendText]', e && e.message); return false; }
}

// Reply within the incoming chat (works for @lid where a raw sendMessage may not),
// falling back to client.sendMessage, and always logging the outbound message.
async function botReply(msg, from, text) {
  try { await msg.reply(text); }
  catch (e) {
    console.error('[botReply] msg.reply failed:', e && e.message);
    try { if (waClient) await waClient.sendMessage(from, text); } catch (e2) { console.error('[botReply] sendMessage failed:', e2 && e2.message); }
  }
  await logMsg(from, 'outbound', text);
}

function faqAnswer(faqs, lower) {
  if (!faqs) return null;
  for (var f of faqs) {
    if (f.keyword && lower.includes(String(f.keyword).toLowerCase())) return f.answer;
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Core message handler
// ---------------------------------------------------------------------------
async function handleMessage(msg) {
  try {
    if (msg.fromMe) return;
    var from = msg.from;
    if (!from || (!from.endsWith('@c.us') && !from.endsWith('@lid'))) return; // 1:1 user chats only
    var text = (msg.body || '').trim();
    var lower = text.toLowerCase();
    console.log('[msg] ' + from + ': ' + text);

    var chatResult = await supabase.from('chats').select('*').eq('phone_number', from).maybeSingle();
    var chat = chatResult.data;
    var nowIso = new Date().toISOString();
    await logMsg(from, 'inbound', text); // always record what they said

    var active = chat && chat.status !== 'closed';

    // A human agent is handling it -> bot stays completely silent
    if (active && chat.status === 'in_progress') return;

    // ---- New conversation: greet with numbered menu, open the ticket --------
    if (!active) {
      await supabase.from('chats').upsert(
        { phone_number: from, status: 'received', last_message: text, sla_start: nowIso, updated_at: nowIso, bot_stage: 'open' },
        { onConflict: 'phone_number' });
      console.log('[ticket] opened for ' + from);
      await botReply(msg, from, GREETING);
      return;
    }

    // ---- Active ticket the bot is handling -----------------------------------
    await supabase.from('chats').update({ last_message: text, updated_at: nowIso }).eq('phone_number', from);

    // Escalation keywords -> hand off to human agent
    if (/\b(human|agent|representative|real person|speak to someone|talk to someone|person)\b/i.test(lower)) {
      await botReply(msg, from, "Sure \u2014 I've passed you to our IT team. They'll reach you within 4 hours. \u{1F64C}");
      await supabase.from('chats').update({ bot_stage: 'escalated', updated_at: nowIso }).eq('phone_number', from);
      return;
    }
    if (chat.bot_stage === 'escalated') return; // already with the team -> bot stays quiet

    // Let the AI (or fallback chain) handle the reply
    await assistantReply(msg, from, text, chat);
  } catch (err) {
    console.error('[handleMessage] error:', err);
  }
}

// ---------------------------------------------------------------------------
//  Dashboard (Express, server-rendered HTML)
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function basicAuth(req, res, next) {
  var h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    var dec = ''; try { dec = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch (e) { dec = ''; }
    var i = dec.indexOf(':');
    if (i >= 0 && dec.slice(0, i) === DASH_USER && dec.slice(i + 1) === DASH_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="IT Support Desk"').status(401).send('Authentication required');
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return String(iso); }
}
function digits(p) { return String(p || '').replace('@c.us', '').replace('@lid', ''); }
function badge(status) {
  var map = { received: 'bg-amber-100 text-amber-800', in_progress: 'bg-blue-100 text-blue-800', closed: 'bg-slate-200 text-slate-600' };
  var label = { received: 'Received', in_progress: 'In progress', closed: 'Closed' };
  return '<span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold ' + (map[status] || '') + '">' + (label[status] || esc(status)) + '</span>';
}
function header() {
  return '<header class="bg-slate-900 text-white"><div class="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">' +
    '<div class="w-9 h-9 rounded-lg bg-emerald-500 flex items-center justify-center font-bold">IT</div>' +
    '<div><div class="font-semibold leading-tight">IT Support Desk</div>' +
    '<div class="text-xs text-slate-400">WhatsApp ticketing &middot; 4-hour SLA</div></div></div></header>';
}
function pageHead(title, refreshSecs) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    (refreshSecs ? '<meta http-equiv="refresh" content="' + refreshSecs + '">' : '') +
    '<title>' + esc(title) + '</title><script src="https://cdn.tailwindcss.com"></script>' +
    '<style>@keyframes fr{0%,100%{background:#fee2e2}50%{background:#fecaca}}.flash{animation:fr 1s ease-in-out infinite}.timer{font-variant-numeric:tabular-nums}</style>' +
    '</head><body class="bg-slate-100 min-h-screen">';
}

function qrPage(qrString) {
  var inner = '<div class="max-w-md mx-auto mt-10 bg-white rounded-2xl shadow p-8 text-center">' +
    '<h1 class="text-xl font-bold mb-1">Link your WhatsApp</h1>' +
    '<p class="text-sm text-slate-500 mb-6">WhatsApp on the bot phone &rarr; <b>Linked Devices</b> &rarr; <b>Link a Device</b>, then scan.</p>' +
    (qrString
      ? '<div class="flex justify-center"><canvas id="qrCanvas" class="rounded-lg"></canvas></div>' +
        '<script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>' +
        '<script>QRCode.toCanvas(document.getElementById("qrCanvas"), "' + qrString + '", { width: 300, margin: 2 });</script>'
      : '<div class="py-16 text-slate-400">Starting WhatsApp engine&hellip;</div>') + '</div>';
  return pageHead('Link WhatsApp', 8) + header() + inner + '</body></html>';
}

function listPage(rows) {
  var open = rows.filter(function (r) { return r.status !== 'closed'; });
  var closed = rows.filter(function (r) { return r.status === 'closed'; });
  function row(r) {
    // SLA countdown: runs while status is 'received'. Pauses when agent takes
    // over ('in_progress'). This ensures the SLA timer stops the moment the
    // human writes in the chat.
    var end = (r.sla_start && r.status === 'received') ? new Date(r.sla_start).getTime() + SLA_MS : 0;
    var slaCell = r.status === 'in_progress'
      ? '<span class="text-xs text-blue-600 font-medium">\u23F8 With agent (SLA paused)</span>'
      : (end ? '<span class="timer text-xs" data-end="' + end + '"></span>' : '<span class="text-xs text-slate-400">-</span>');
    return '<tr class="border-t border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-mono text-xs">' + esc(digits(r.phone_number)) + '</td>' +
      '<td class="px-4 py-3 max-w-xs truncate">' + esc(r.last_message || '') + '</td>' +
      '<td class="px-4 py-3">' + badge(r.status) + '</td>' +
      '<td class="px-4 py-3">' + slaCell + '</td>' +
      '<td class="px-4 py-3"><a href="/ticket?phone=' + encodeURIComponent(r.phone_number) + '" class="bg-slate-900 hover:bg-slate-700 text-white text-xs font-semibold rounded-md px-3 py-1.5">Open chat</a></td></tr>';
  }
  var allRows = rows.length ? rows.map(row).join('') : '<tr><td colspan="5" class="px-4 py-10 text-center text-slate-400">No tickets yet.</td></tr>';
  function stat(l, v, c) { return '<div class="bg-white rounded-xl shadow-sm px-5 py-4 flex-1"><div class="text-2xl font-bold ' + c + '">' + v + '</div><div class="text-xs text-slate-500 uppercase">' + l + '</div></div>'; }
  var inner = header() + '<main class="max-w-5xl mx-auto px-6 py-6">' +
    '<div class="flex gap-4 mb-6">' +
      stat('Received', String(rows.filter(function (r) { return r.status === 'received'; }).length), 'text-amber-600') +
      stat('In progress', String(rows.filter(function (r) { return r.status === 'in_progress'; }).length), 'text-blue-600') +
      stat('Closed', String(closed.length), 'text-slate-700') + '</div>' +
    '<div class="bg-white rounded-xl shadow-sm overflow-hidden">' +
    '<div class="px-4 py-3 border-b border-slate-100 font-semibold">All tickets</div>' +
    '<table class="w-full text-sm"><thead class="bg-slate-50 text-slate-500 text-[11px] uppercase"><tr>' +
    '<th class="px-4 py-2 text-left">Phone</th><th class="px-4 py-2 text-left">Last message</th>' +
    '<th class="px-4 py-2 text-left">Status</th><th class="px-4 py-2 text-left">SLA</th><th class="px-4 py-2 text-left"></th>' +
    '</tr></thead><tbody>' + allRows + '</tbody></table></div>' +
    '<p class="text-xs text-slate-400 mt-3">Auto-refreshes every 12s.</p></main>' +
    '<script>(function(){function pad(n){return (n<10?"0":"")+n;}function tick(){var els=document.querySelectorAll(".timer[data-end]");for(var i=0;i<els.length;i++){var end=parseInt(els[i].getAttribute("data-end"),10);if(!end){els[i].textContent="-";continue;}var ms=end-Date.now();if(ms<=0){els[i].textContent="BREACHED";els[i].style.color="#dc2626";continue;}var h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000);els[i].textContent=pad(h)+"h "+pad(m)+"m";els[i].style.color=ms<3600000?"#dc2626":"#334155";}}tick();setInterval(tick,1000);})();</script>';
  return pageHead('IT Support Desk', 12) + inner + '</body></html>';
}

function chatPage(chat) {
  var phone = chat.phone_number;
  var enc = encodeURIComponent(phone);
  var statusBtns =
    '<form method="POST" action="/api/status" class="inline"><input type="hidden" name="phone" value="' + esc(phone) + '">' +
    '<input type="hidden" name="status" value="in_progress"><button class="text-xs bg-blue-600 text-white rounded px-2 py-1">In progress</button></form> ' +
    '<form method="POST" action="/api/status" class="inline"><input type="hidden" name="phone" value="' + esc(phone) + '">' +
    '<input type="hidden" name="status" value="closed"><button class="text-xs bg-slate-600 text-white rounded px-2 py-1">Close</button></form> ' +
    '<form method="POST" action="/api/status" class="inline"><input type="hidden" name="phone" value="' + esc(phone) + '">' +
    '<input type="hidden" name="status" value="received"><button class="text-xs bg-amber-500 text-white rounded px-2 py-1">Reopen</button></form>';
  var inner = header() + '<main class="max-w-3xl mx-auto px-4 py-6">' +
    '<a href="/" class="text-sm text-blue-600">&larr; All tickets</a>' +
    '<div class="bg-white rounded-xl shadow-sm mt-3 overflow-hidden flex flex-col" style="height:72vh">' +
    '<div class="px-4 py-3 border-b border-slate-100 flex items-center justify-between">' +
    '<div><div class="font-semibold font-mono text-sm">' + esc(digits(phone)) + '</div><div class="mt-1">' + badge(chat.status) + '</div></div>' +
    '<div class="space-x-1">' + statusBtns + '</div></div>' +
    '<div id="log" class="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50"></div>' +
    '<form id="reply" class="border-t border-slate-100 p-3 flex gap-2">' +
    '<input id="text" autocomplete="off" placeholder="Type a reply to the customer..." class="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm">' +
    '<button class="bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-lg px-4">Send</button></form>' +
    '</div></main>' +
    '<script>(function(){var PHONE=' + JSON.stringify(phone) + ';var log=document.getElementById("log");' +
    'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
    'function render(items){var h="";for(var i=0;i<items.length;i++){var m=items[i];var out=m.direction==="outbound";' +
    'h+="<div class=\\"flex "+(out?"justify-end":"justify-start")+"\\"><div class=\\"max-w-[80%] px-3 py-2 rounded-2xl text-sm "+(out?"bg-emerald-600 text-white":"bg-white border border-slate-200")+"\\">"+esc(m.content)+"</div></div>";}' +
    'var atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<60;log.innerHTML=h;if(atBottom)log.scrollTop=log.scrollHeight;}' +
    'function load(){fetch("/api/messages?phone="+encodeURIComponent(PHONE), {credentials: "same-origin"}).then(function(r){return r.json();}).then(function(d){render(d.messages||[]);}).catch(function(){});}' +
    'document.getElementById("reply").addEventListener("submit",function(e){e.preventDefault();var t=document.getElementById("text");var v=t.value.trim();if(!v)return;t.value="";' +
    'fetch("/api/reply",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone:PHONE,text:v})}).then(function(){load();}).catch(function(){t.value=v;});});' +
    'load();setInterval(load,4000);})();</script>';
  return pageHead('Chat - ' + digits(phone), 0) + inner + '</body></html>';
}

// ---------------------------------------------------------------------------
//  Express server
// ---------------------------------------------------------------------------
function startServer() {
  var app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get('/healthz', function (_q, r) { r.json({ ok: true, whatsapp: wa.connected ? 'connected' : 'waiting', gemini: GEMINI_API_KEY ? 'configured' : 'not configured' }); });

  app.get('/', basicAuth, async function (req, res) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!wa.connected) {
      return res.send(qrPage(wa.qr));
    }
    var result = await supabase.from('chats').select('*').order('updated_at', { ascending: false });
    res.send(listPage(result.data || []));
  });

  app.get('/ticket', basicAuth, async function (req, res) {
    var phone = String(req.query.phone || '');
    var result = await supabase.from('chats').select('*').eq('phone_number', phone).maybeSingle();
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!result.data) return res.send(pageHead('Not found', 0) + header() + '<p class="p-8">Ticket not found. <a href="/" class="text-blue-600">Back</a></p></body></html>');
    res.send(chatPage(result.data));
  });

  app.get('/api/messages', basicAuth, async function (req, res) {
    var phone = String(req.query.phone || '');
    var result = await supabase.from('chat_messages').select('direction, content, created_at')
      .eq('phone_number', phone).order('created_at', { ascending: true }).limit(500);
    res.json({ messages: result.data || [] });
  });

  // Agent replies from the dashboard — sets status to 'in_progress' which
  // pauses the SLA timer and silences the bot.
  app.post('/api/reply', basicAuth, async function (req, res) {
    var phone = String(req.body.phone || '');
    var text = String(req.body.text || '').trim();
    if (!phone || !text) return res.status(400).json({ error: 'phone and text required' });
    await sendText(phone, text);
    // Agent has taken over -> mark in_progress so the bot stays quiet and SLA pauses.
    await supabase.from('chats').update({ status: 'in_progress', last_message: text, updated_at: new Date().toISOString() }).eq('phone_number', phone);
    res.json({ ok: true });
  });

  app.post('/api/status', basicAuth, async function (req, res) {
    var phone = String(req.body.phone || '');
    var status = String(req.body.status || '');
    if (['received', 'in_progress', 'closed'].indexOf(status) >= 0 && phone) {
      await supabase.from('chats').update({ status: status, updated_at: new Date().toISOString() }).eq('phone_number', phone);
    }
    res.redirect('/ticket?phone=' + encodeURIComponent(phone));
  });

  app.listen(PORT, function () { console.log('[OK] Dashboard on http://localhost:' + PORT); });
}

// ---------------------------------------------------------------------------
//  WhatsApp client (whatsapp-web.js)
// ---------------------------------------------------------------------------
function startWhatsApp() {
  var puppeteer = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--headless=new', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) puppeteer.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

  var client = new Client({
    authStrategy: new LocalAuth({ dataPath: process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth' }),
    puppeteer: puppeteer,
  });
  waClient = client;

  client.on('qr', function (qr) { wa.qr = qr; wa.connected = false; console.log('\nQR ready - scan from the dashboard.\n'); qrcode.generate(qr, { small: true }); });
  client.on('authenticated', function () { console.log('[OK] WhatsApp authenticated.'); });
  client.on('ready', function () { wa.connected = true; wa.qr = null; console.log('[OK] WhatsApp READY - bot live.'); });
  client.on('auth_failure', function (m) { wa.connected = false; banner('WhatsApp auth failure: ' + m); });
  client.on('disconnected', function (reason) {
    wa.connected = false;
    console.warn('[whatsapp] disconnected: ' + reason + ' - reinitializing in 5s');
    setTimeout(function () { client.initialize().catch(function (e) { console.error('[whatsapp] re-init failed:', e); }); }, 5000);
  });

  // Handle BOTH events: as a linked device, incoming messages often arrive via
  // 'message_create' rather than 'message'. Dedupe by id so each is processed once.
  var seen = new Set();
  async function onMessage(msg, evt) {
    try {
      var id = msg && msg.id && msg.id._serialized;
      console.log('[event] ' + evt + ' from=' + (msg && msg.from) + ' fromMe=' + (msg && msg.fromMe));
      if (id) { if (seen.has(id)) return; seen.add(id); if (seen.size > 5000) seen.clear(); }
      await handleMessage(msg);
    } catch (e) { console.error('[onMessage]', e); }
  }
  client.on('message', function (m) { onMessage(m, 'message'); });
  client.on('message_create', function (m) { onMessage(m, 'message_create'); });

  client.initialize().catch(function (e) { banner('WhatsApp failed to initialize: ' + (e && e.message)); });
}

process.on('unhandledRejection', function (e) { console.error('[unhandledRejection]', e); });
process.on('uncaughtException', function (e) { console.error('[uncaughtException]', e); });

(async function main() {
  console.log('Starting IT Support Desk bot.');
  await selfCheck();
  startServer();
  startWhatsApp();
})();
