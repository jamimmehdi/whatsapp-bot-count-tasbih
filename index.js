require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

// ─── Persistent Storage ───────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// ─── In-memory cache — load once, write async ─────────────────────────────────
let cachedData = null;

function loadData() {
    if (cachedData) return cachedData;
    if (!fs.existsSync(DATA_FILE)) {
        cachedData = { groups: {} };
        return cachedData;
    }
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.groups) data.groups = {};
    cachedData = data;
    return cachedData;
}

function getGroupData(data, groupId, groupName) {
    if (!data.groups[groupId]) {
        data.groups[groupId] = { name: groupName, grandTotal: 0, memberTotals: {}, history: [] };
    }
    return data.groups[groupId];
}

function saveData(data) {
    cachedData = data;
    // Write to disk asynchronously — doesn't block the reply
    fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
        if (err) console.error('❌ Failed to save data:', err.message);
    });
}

// ─── Parse Count ──────────────────────────────────────────────────────────────
function parseCount(text) {
    if (!text) return null;

    const cleaned = text
        .replace(/\+/g, '')
        .replace(/,/g, '')
        .replace(/،/g, '')
        .trim();

    const normalized = cleaned.replace(/[٠-٩]/g, d =>
        '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString()
    );

    const num = parseInt(normalized);
    return isNaN(num) ? null : num;
}

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
let qrCodeData = null;
let clientReady = false;
const processedMessages = new Set();

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, '.wwebjs_auth') }),
    webVersionCache: {
        type: 'local',
        path: path.join(DATA_DIR, '.wwebjs_cache'),
    },
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
            || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--disable-extensions',
            '--disable-default-apps',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--safebrowsing-disable-auto-update',
        ],
    }
});

client.on('qr', (qr) => {
    qrCodeData = qr;
    clientReady = false;
    console.log('📱 QR code ready — visit http://localhost:3000/qr to scan');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    clientReady = true;
    qrCodeData = null;
    console.log('✅ WhatsApp client ready!');
});

client.on('disconnected', () => {
    clientReady = false;
    console.log('❌ WhatsApp disconnected');
});

client.on('message_create', async (msg) => {
    // Deduplicate — use sender+timestamp as a stable key since id._serialized
    // can differ across duplicate firings of the same message
    const msgKey = `${msg.from}_${msg.author || ''}_${msg.timestamp}`;
    if (processedMessages.has(msgKey)) return;
    processedMessages.add(msgKey);
    if (processedMessages.size > 500) processedMessages.delete(processedMessages.values().next().value);

    console.log('📨 message_create:', msg.body, '| fromMe:', msg.fromMe);

    // Ignore the bot's own replies
    if (msg.fromMe && msg.body.includes('Grand Total')) return;

    try {
        // Skip WhatsApp Channels which cause parse errors
        let chat;
        try {
            chat = await msg.getChat();
        } catch (e) {
            console.log('⚠️ Skipping unparseable chat (Channel/broadcast)');
            return;
        }

        // Only respond in groups
        if (!chat.name.includes('[BotCount]')) {
            console.log('⏭️ Not a BotCount group, skipping:', chat.name);
            return;
        }

        const count = parseCount(msg.body);
        console.log('🔢 Parsed count:', count);

        if (!count || count <= 0) {
            console.log('⏭️ No valid count found');
            return;
        }

        // Fetch contact name and update data in parallel
        const data = loadData();
        const groupData = getGroupData(data, chat.id._serialized, chat.name);
        groupData.grandTotal += count;

        // Resolve contact name and send reply at the same time
        const [name] = await Promise.all([
            msg.getContact()
                .then(c => c.pushname || c.number || msg.author || 'Unknown')
                .catch(() => msg.author || 'Unknown'),
        ]);

        groupData.memberTotals[name] = (groupData.memberTotals[name] || 0) + count;
        groupData.history.push({
            name,
            count,
            total: groupData.grandTotal,
            time: new Date().toISOString(),
        });

        if (groupData.history.length > 100) groupData.history = groupData.history.slice(-100);
        saveData(data); // async — doesn't block

        console.log(`✅ [${chat.name}] ${name} added ${count}, grand total: ${groupData.grandTotal}`);

        const reply =
            `📿 *${name}* added *${count.toLocaleString()}+*\n\n` +
            `🕌 Grand Total: *${groupData.grandTotal.toLocaleString()}*\n\n` +
            `سُبْحَانَ ٱللَّٰه`;

        if (msg.fromMe) {
            await chat.sendMessage(reply);
        } else {
            await msg.reply(reply);
        }
        console.log('💬 Reply sent!');

    } catch (err) {
        console.error('❌ Message handler error:', err.message);
    }
});

client.initialize();

// ─── Express Routes ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    const data = loadData();
    const groups = Object.entries(data.groups || {}).map(([id, g]) => ({
        id,
        name: g.name,
        grandTotal: g.grandTotal,
        members: Object.keys(g.memberTotals).length,
    }));
    res.json({
        status: clientReady ? 'connected' : 'waiting_for_qr',
        groups,
    });
});

app.get('/qr', (req, res) => {
    if (clientReady) {
        return res.send('<h2 style="font-family:sans-serif">✅ WhatsApp already connected!</h2>');
    }
    if (!qrCodeData) {
        return res.send('<h2 style="font-family:sans-serif">⏳ Generating QR code, refresh in a few seconds...</h2>');
    }
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Tasbih Bot — Scan QR</title>
      <meta http-equiv="refresh" content="30">
      <style>
        body { font-family: sans-serif; display: flex; flex-direction: column;
               align-items: center; justify-content: center; min-height: 100vh;
               background: #0d0f0e; color: #e8ede9; }
        h2 { margin-bottom: 10px; }
        p  { color: #6b7a6e; margin-bottom: 24px; }
        img { border: 4px solid #7ec88a; border-radius: 12px; }
      </style>
    </head>
    <body>
      <h2>📿 Tasbih Bot</h2>
      <p>Open WhatsApp → Linked Devices → Link a Device → Scan this QR</p>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrCodeData)}" />
      <p style="margin-top:16px">Page auto-refreshes every 30s</p>
    </body>
    </html>
  `);
});

// /stats?group=<groupId>  — omit groupId to get all groups
app.get('/stats', (req, res) => {
    const data = loadData();
    const { group } = req.query;

    if (group) {
        const g = (data.groups || {})[group];
        if (!g) return res.status(404).json({ error: 'Group not found' });
        const sorted = Object.entries(g.memberTotals).sort((a, b) => b[1] - a[1]);
        return res.json({
            groupId: group,
            groupName: g.name,
            grandTotal: g.grandTotal,
            memberCount: sorted.length,
            leaderboard: sorted.map(([name, total]) => ({ name, total })),
            recentHistory: g.history.slice(-10).reverse(),
        });
    }

    // All groups summary
    const summary = Object.entries(data.groups || {}).map(([id, g]) => {
        const sorted = Object.entries(g.memberTotals).sort((a, b) => b[1] - a[1]);
        return {
            groupId: id,
            groupName: g.name,
            grandTotal: g.grandTotal,
            memberCount: sorted.length,
            leaderboard: sorted.map(([name, total]) => ({ name, total })),
        };
    });
    res.json({ groups: summary });
});

// ─── Manual Entry UI ──────────────────────────────────────────────────────────
app.get('/add', (req, res) => {
    const data = loadData();
    const groups = Object.entries(data.groups || {}).map(([id, g]) => ({
        id,
        name: g.name,
        members: Object.keys(g.memberTotals),
    }));

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Tasbih Bot — Manual Entry</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #0d0f0e; color: #e8ede9; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #161a17; border: 1px solid #2a332c; border-radius: 16px;
            padding: 32px; width: 100%; max-width: 420px; }
    h2 { font-size: 1.3rem; margin-bottom: 6px; }
    .subtitle { color: #6b7a6e; font-size: 0.9rem; margin-bottom: 28px; }
    label { display: block; font-size: 0.85rem; color: #9db09f; margin-bottom: 6px; }
    select, input { width: 100%; padding: 10px 14px; border-radius: 8px;
                    border: 1px solid #2a332c; background: #1e2620; color: #e8ede9;
                    font-size: 1rem; margin-bottom: 20px; outline: none; }
    select:focus, input:focus { border-color: #7ec88a; }
    button { width: 100%; padding: 12px; background: #7ec88a; color: #0d0f0e;
             font-size: 1rem; font-weight: 600; border: none; border-radius: 8px;
             cursor: pointer; transition: background 0.2s; }
    button:hover { background: #6ab876; }
    button:disabled { background: #3a4a3c; color: #6b7a6e; cursor: not-allowed; }
    .new-member { font-size: 0.8rem; color: #6b7a6e; margin-top: -14px; margin-bottom: 20px; }
    .new-member a { color: #7ec88a; cursor: pointer; text-decoration: none; }
    #newMemberInput { display: none; }
    .toast { display: none; margin-top: 20px; padding: 12px 16px; border-radius: 8px;
             font-size: 0.9rem; text-align: center; }
    .toast.success { background: #1e3a22; color: #7ec88a; border: 1px solid #2d5232; }
    .toast.error   { background: #3a1e1e; color: #e87e7e; border: 1px solid #522d2d; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📿 Manual Entry</h2>
    <p class="subtitle">Add a count on behalf of a group member</p>

    <label for="groupSelect">Group</label>
    <select id="groupSelect">
      <option value="">— Select a group —</option>
      ${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
    </select>

    <label for="memberSelect">Member</label>
    <select id="memberSelect" disabled>
      <option value="">— Select a member —</option>
    </select>
    <p class="new-member">Not in the list? <a onclick="toggleNewMember()">Add new member</a></p>

    <div id="newMemberInput">
      <label for="newMemberName">New Member Name</label>
      <input type="text" id="newMemberName" placeholder="Enter name" />
    </div>

    <label for="countInput">Count to Add</label>
    <input type="number" id="countInput" placeholder="e.g. 100" min="1" />

    <button id="submitBtn" disabled onclick="submitEntry()">Add Count</button>
    <div class="toast" id="toast"></div>
  </div>

  <script>
    const groups = ${JSON.stringify(groups)};

    document.getElementById('groupSelect').addEventListener('change', function () {
      const groupId = this.value;
      const memberSelect = document.getElementById('memberSelect');
      memberSelect.innerHTML = '<option value="">— Select a member —</option>';
      memberSelect.disabled = !groupId;
      document.getElementById('submitBtn').disabled = true;

      if (groupId) {
        const group = groups.find(g => g.id === groupId);
        if (group && group.members.length > 0) {
          group.members.sort().forEach(m => {
            const opt = document.createElement('option');
            opt.value = m; opt.textContent = m;
            memberSelect.appendChild(opt);
          });
        }
      }
    });

    document.getElementById('memberSelect').addEventListener('change', updateSubmitBtn);
    document.getElementById('countInput').addEventListener('input', updateSubmitBtn);
    document.getElementById('newMemberName').addEventListener('input', updateSubmitBtn);

    function updateSubmitBtn() {
      const group = document.getElementById('groupSelect').value;
      const member = document.getElementById('memberSelect').value;
      const newMember = document.getElementById('newMemberName').value.trim();
      const count = document.getElementById('countInput').value;
      const isNewMemberMode = document.getElementById('newMemberInput').style.display === 'block';
      document.getElementById('submitBtn').disabled =
        !group || (!member && !newMember) || !count || count < 1;
    }

    function toggleNewMember() {
      const el = document.getElementById('newMemberInput');
      el.style.display = el.style.display === 'block' ? 'none' : 'block';
      document.getElementById('memberSelect').value = '';
      updateSubmitBtn();
    }

    async function submitEntry() {
      const groupId = document.getElementById('groupSelect').value;
      const member = document.getElementById('memberSelect').value;
      const newMember = document.getElementById('newMemberName').value.trim();
      const count = parseInt(document.getElementById('countInput').value);
      const name = newMember || member;

      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Adding...';

      try {
        const res = await fetch('/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupId, name, count }),
        });
        const json = await res.json();
        showToast(res.ok ? 'success' : 'error',
          res.ok ? '✅ ' + json.message : '❌ ' + json.error);
        if (res.ok) document.getElementById('countInput').value = '';
      } catch (e) {
        showToast('error', '❌ Request failed');
      }
      btn.disabled = false;
      btn.textContent = 'Add Count';
    }

    function showToast(type, msg) {
      const t = document.getElementById('toast');
      t.className = 'toast ' + type;
      t.textContent = msg;
      t.style.display = 'block';
      setTimeout(() => t.style.display = 'none', 4000);
    }
  </script>
</body>
</html>`);
});

app.post('/add', (req, res) => {
    const { groupId, name, count } = req.body;

    if (!groupId || !name || !count || count <= 0)
        return res.status(400).json({ error: 'groupId, name, and a positive count are required' });

    const data = loadData();
    const group = (data.groups || {})[groupId];
    if (!group) return res.status(404).json({ error: 'Group not found' });

    group.grandTotal += count;
    group.memberTotals[name] = (group.memberTotals[name] || 0) + count;
    group.history.push({ name, count, total: group.grandTotal, time: new Date().toISOString() });
    if (group.history.length > 100) group.history = group.history.slice(-100);
    saveData(data);

    console.log(`✅ [Manual] [${group.name}] ${name} added ${count}, grand total: ${group.grandTotal}`);
    res.json({ success: true, message: `${name} +${count.toLocaleString()} → Grand Total: ${group.grandTotal.toLocaleString()}` });
});

// /reset?group=<groupId>  — omit groupId to reset ALL groups
app.post('/reset', (req, res) => {
    const data = loadData();
    const { group } = req.query;

    if (group) {
        if (!(data.groups || {})[group]) return res.status(404).json({ error: 'Group not found' });
        data.groups[group] = { ...data.groups[group], grandTotal: 0, memberTotals: {}, history: [] };
        saveData(data);
        return res.json({ success: true, message: `Counter reset for group: ${data.groups[group].name}` });
    }

    saveData({ groups: {} });
    res.json({ success: true, message: 'All group counters reset' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Tasbih bot running on port ${PORT}`);
    console.log(`   Visit http://localhost:${PORT}/qr to connect WhatsApp`);
});