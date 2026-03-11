const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { executablePath } = require('puppeteer');

const app = express();
app.use(express.json());

// ─── Persistent Storage ───────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        return { grandTotal: 0, memberTotals: {}, history: [] };
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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


function getChromeExecutable() {
    if (!process.env.RENDER) {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    try {
        // Find whatever chrome was installed by puppeteer
        const result = execSync('find /opt/render -name "chrome" -type f 2>/dev/null').toString().trim();
        const path = result.split('\n')[0];
        console.log('🔍 Found Chrome at:', path);
        return path;
    } catch (e) {
        console.log('⚠️ Could not find chrome, trying default');
        return null;
    }
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
            || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
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

        // Update data
        const data = loadData();
        data.grandTotal += count;

        let name;
        try {
            const contact = await msg.getContact();
            name = contact.pushname || contact.number || msg.author || 'Unknown';
        } catch (e) {
            name = msg.author || 'Unknown';
        }

        data.memberTotals[name] = (data.memberTotals[name] || 0) + count;
        data.history.push({
            name,
            count,
            total: data.grandTotal,
            time: new Date().toISOString(),
        });

        if (data.history.length > 100) data.history = data.history.slice(-100);
        saveData(data);

        console.log(`✅ ${name} added ${count}, grand total: ${data.grandTotal}`);

        const reply =
            `📿 *${name}* added *${count.toLocaleString()}+*\n\n` +
            `🕌 Grand Total: *${data.grandTotal.toLocaleString()}*\n\n` +
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
    res.json({
        status: clientReady ? 'connected' : 'waiting_for_qr',
        grandTotal: data.grandTotal,
        members: Object.keys(data.memberTotals).length,
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

app.get('/stats', (req, res) => {
    const data = loadData();
    const sorted = Object.entries(data.memberTotals).sort((a, b) => b[1] - a[1]);
    res.json({
        grandTotal: data.grandTotal,
        memberCount: sorted.length,
        leaderboard: sorted.map(([name, total]) => ({ name, total })),
        recentHistory: data.history.slice(-10).reverse(),
    });
});

app.post('/reset', (req, res) => {
    saveData({ grandTotal: 0, memberTotals: {}, history: [] });
    res.json({ success: true, message: 'Counter reset to 0' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Tasbih bot running on port ${PORT}`);
    console.log(`   Visit http://localhost:${PORT}/qr to connect WhatsApp`);
});