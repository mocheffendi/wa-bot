const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const figlet = require("figlet");
const http = require("http");

const app = express();
app.use(express.json());

let sock; // WhatsApp socket
let connected = false;
let currentQR = ""; // simpan QR

const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Setup untuk menerima file image upload
const upload = multer({ dest: 'uploads/' });

// Start bot function
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            currentQR = qr;
            console.log("QR code updated, ready to scan.");
        }

        if (connection === "close") {
            connected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("Disconnected. Reconnecting:", shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            connected = true;
            currentQR = "";
            console.log(figlet.textSync("ZahraBot Aktif"));
            console.log("✅ WhatsApp Connected");
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        console.log(`📩 ${sender}: ${text}`);

        if (text?.toLowerCase() === "halo") {
            await sock.sendMessage(sender, { text: "Halo juga dari ZahraBot! 👋" });
        }
    });
}

startBot();

// ------------------------
// EXPRESS ENDPOINTS
// ------------------------

app.get("/", (req, res) => {
    res.send("ZahraBot is running. Scan QR at <a href='/qr'>/qr</a>");
});

// Endpoint JSON QR code
app.get("/qr-code", (req, res) => {
    res.json({ qr: currentQR });
});

// Halaman QR dengan auto refresh
app.get("/qr", (req, res) => {
    res.send(`
    <html>
      <head>
        <title>Scan QR WhatsApp</title>
        <style>
          body { text-align: center; font-family: sans-serif; padding-top: 50px; }
          #qr-img { margin-top: 20px; }
        </style>
      </head>
      <body>
        <h2>Scan QR WhatsApp</h2>
        <div id="qr-container"><p>Memuat QR...</p></div>
        <div id="status" style="margin-top:20px;font-weight:bold;"></div>
        <script>
          async function loadQR() {
            try {
              const res = await fetch('/qr-code');
              const data = await res.json();
              const container = document.getElementById('qr-container');
              if (!data.qr) {
                container.innerHTML = '<p>✅ QR tidak tersedia atau sudah discan.</p>';
                return;
              }
              container.innerHTML = \`
                <img id="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?data=\${encodeURIComponent(data.qr)}&size=250x250" />
                <p>Scan pakai aplikasi WhatsApp kamu!</p>
              \`;
            } catch (err) {
              console.error('Gagal memuat QR:', err);
            }
          }

          async function checkStatus() {
            const res = await fetch('/status');
            const data = await res.json();
            const statusEl = document.getElementById('status');
            statusEl.textContent = data.status === 'connected' ? '✅ WhatsApp sudah terhubung!' : '⏳ Menunggu koneksi...';
            statusEl.style.color = data.status === 'connected' ? 'green' : 'orange';
          }

          loadQR();
          checkStatus();
          setInterval(loadQR, 5000);
          setInterval(checkStatus, 3000);
        </script>
      </body>
    </html>
  `);
});

// Status koneksi
app.get("/status", (req, res) => {
    res.json({ status: connected ? "connected" : "disconnected" });
});

// Kirim pesan
app.post("/send", async (req, res) => {
    const { number, message } = req.body;

    if (!connected || !sock) {
        return res.status(400).json({ error: "❌ WhatsApp belum terhubung." });
    }

    const jid = number.includes("@s.whatsapp.net") || number.includes("@g.us")
        ? number
        : `${number}@s.whatsapp.net`;

    try {
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, to: number });
    } catch (err) {
        console.error("❌ Gagal kirim pesan:", err);
        res.status(500).json({
            error: "Gagal kirim pesan.",
            detail: err?.message || err.toString()
        });
    }
});

app.get("/groups", async (req, res) => {
    if (!connected || !sock) {
        return res.status(400).json({ error: "❌ WhatsApp belum terhubung." });
    }

    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(group => ({
            id: group.id,
            name: group.subject
        }));

        res.json({ success: true, groups: groupList });
    } catch (err) {
        console.error("❌ Gagal mengambil daftar grup:", err);
        res.status(500).json({ error: "Gagal mengambil daftar grup." });
    }
});

app.post("/send-image", upload.single("image"), async (req, res) => {
    const { number, caption } = req.body;

    if (!connected || !sock) {
        return res.status(400).json({ error: "❌ WhatsApp belum terhubung." });
    }

    if (!req.file) {
        return res.status(400).json({ error: "❌ File gambar tidak ditemukan." });
    }

    const imagePath = path.join(__dirname, req.file.path);
    const buffer = fs.readFileSync(imagePath);

    const jid = number.includes("@s.whatsapp.net") ? number : `${number}@s.whatsapp.net`;

    try {
        await sock.sendMessage(jid, {
            image: buffer,
            caption: caption || "📸 Gambar terkirim"
        });
        fs.unlinkSync(imagePath); // Hapus file setelah dikirim
        res.json({ success: true, to: number });
    } catch (err) {
        console.error("❌ Gagal kirim gambar:", err);
        res.status(500).json({ error: "Gagal kirim gambar." });
    }
});

// Port dummy untuk keepalive (opsional)
http.createServer((req, res) => res.end("ZahraBot Active")).listen(8080);

// Jalankan server express
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Express server running on http://localhost:${PORT}`);
});
