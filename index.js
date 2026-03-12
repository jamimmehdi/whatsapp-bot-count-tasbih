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