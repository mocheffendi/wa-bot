// ZahraBot - Multi Session WhatsApp Bot + Web UI + WebSocket Live QR + Group Members API
const express = require("express");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const figlet = require("figlet");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const sessions = {}; // Menyimpan semua session

// Function to start a WhatsApp bot session
async function startBot(sessionId = "default") {
    const { state, saveCreds } = await useMultiFileAuthState(`./auth/${sessionId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
    });

    sessions[sessionId] = { sock, qr: "", connected: false };

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
        if (qr) {
            sessions[sessionId].qr = qr;
            sessions[sessionId].qrTimestamp = Date.now();
            // Emit QR code immediately to the connected session
            io.to(sessionId).emit("qr", qr);
        }

        if (connection === "open") {
            sessions[sessionId].connected = true;
            sessions[sessionId].qr = "";
            io.to(sessionId).emit("connected");
            console.log(figlet.textSync(`ZahraBot-${sessionId}`));
            console.log(`✅ Session ${sessionId} connected`);
        }

        if (connection === "close") {
            sessions[sessionId].connected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`🔁 Session ${sessionId} disconnected. Reconnect: ${shouldReconnect}`);
            if (shouldReconnect) startBot(sessionId);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text?.toLowerCase() === "halo") {
            await sock.sendMessage(sender, { text: `Halo juga dari ZahraBot-${sessionId} 👋` });
        }
    });
}

// ------------------- UI HTML -------------------
app.get("/", (req, res) => {
    res.send(`
      <html>
        <head>
          <title>ZahraBot Multi Session</title>
          <script src="/socket.io/socket.io.js"></script>
          <style>
            body { font-family: sans-serif; text-align: center; padding: 40px; }
            input, select, button, textarea { padding: 10px; margin: 5px; width: 300px; }
            .card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; max-width: 500px; margin: auto; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>ZahraBot Multi Session</h2>
            <input type="text" id="sessionId" placeholder="Masukkan nama session" /><br/>
            <button onclick="startSession()">🚀 Mulai Session</button>
            <div id="qrSection" style="display:none">
              <h3>Scan QR:</h3>
              <img id="qrImage" src="" style="width:250px;height:250px" />
              <p id="qrStatus">Menunggu QR...</p>
            </div>
            <div id="statusSection" style="margin-top:20px; display:none">
              <h3>Status:</h3>
              <p id="status"></p>
              <h4>Kirim Pesan</h4>
              <input type="text" id="to" placeholder="Nomor atau ID Grup" /><br/>
              <textarea id="message" placeholder="Isi pesan"></textarea><br/>
              <button onclick="sendMessage()">📤 Kirim</button>
            </div>
          </div>

          <script>
            let sessionId = "";
            let socket;

            function startSession() {
              sessionId = document.getElementById("sessionId").value;
              if (!sessionId) return alert("Masukkan nama session");
              fetch("/start/${sessionId}").then(() => {
                document.getElementById("qrSection").style.display = "block";
                document.getElementById("statusSection").style.display = "block";
                document.getElementById("qrStatus").innerText = "Menunggu QR...";
                socket = io();
                socket.emit("join", sessionId);
                socket.on("qr", qr => {
                  // Update the QR code image immediately
                  document.getElementById("qrImage").src = "https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=250x250";
                  document.getElementById("qrStatus").innerText = "QR Diperbarui";
                });
                socket.on("connected", () => {
                  document.getElementById("qrStatus").innerText = "✅ Terhubung";
                  document.getElementById("status").innerText = "Session ${sessionId} sudah aktif dan terhubung.";
                });
              });
            }

            function sendMessage() {
              const to = document.getElementById("to").value;
              const message = document.getElementById("message").value;
              fetch("/send/${sessionId}", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ number: to, message })
              }).then(r => r.json()).then(data => {
                alert(data.success ? "✅ Pesan terkirim" : "❌ Gagal: ${data.error}");
              });
            }
          </script>
        </body>
      </html>
    `);
});

// ------------------- ROUTES -------------------
app.get("/start/:sessionId", async (req, res) => {
    const { sessionId } = req.params;
    if (sessions[sessionId]?.connected) {
        return res.redirect(`/?session=${sessionId}&status=connected`);
    }
    await startBot(sessionId);
    res.redirect(`/?session=${sessionId}&status=started`);
});

app.get("/qr/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    const session = sessions[sessionId];
    if (!session) return res.status(404).send("Session tidak ditemukan");

    res.send(`
      <html>
        <head>
          <script src="/socket.io/socket.io.js"></script>
          <script>
            const socket = io();
            socket.emit("join", "${sessionId}");
            socket.on("qr", qr => {
              document.getElementById("qr-img").src = \`https://api.qrserver.com/v1/create-qr-code/?data=\${encodeURIComponent(qr)}&size=250x250\`;
            });
            socket.on("connected", () => {
              document.getElementById("status").innerText = "✅ Terhubung!";
            });
          </script>
        </head>
        <body style="text-align:center;font-family:sans-serif">
          <h2>Scan QR Session ${sessionId}</h2>
          <img id="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(session.qr)}&size=250x250" />
          <p id="status">Menunggu koneksi...</p>
        </body>
      </html>
    `);
});

app.get("/status/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    const session = sessions[sessionId];
    res.json({ session: sessionId, status: session?.connected ? "connected" : "disconnected" });
});

app.get("/groups/:sessionId", async (req, res) => {
    const { sessionId } = req.params;
    const client = sessions[sessionId];
    if (!client?.connected) return res.status(400).json({ error: "❌ Session belum terhubung." });

    try {
        const groups = await client.sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        res.json({ success: true, groups: groupList });
    } catch (err) {
        res.status(500).json({ error: "Gagal ambil grup.", detail: err?.message });
    }
});

app.get("/group-members/:sessionId/:groupId", async (req, res) => {
    const { sessionId, groupId } = req.params;
    const client = sessions[sessionId];

    if (!client?.connected) {
        return res.status(400).json({ error: "❌ Session belum terhubung." });
    }

    try {
        const metadata = await client.sock.groupMetadata(groupId);
        const participants = metadata.participants.map(p => ({
            id: p.id,
            isAdmin: p.admin === "admin" || p.admin === "superadmin",
            isSuperAdmin: p.admin === "superadmin"
        }));
        res.json({ success: true, group: metadata.subject, participants });
    } catch (err) {
        res.status(500).json({ error: "Gagal ambil data member grup.", detail: err?.message });
    }
});

app.post("/send/:sessionId", async (req, res) => {
    const { sessionId } = req.params;
    const { number, message } = req.body;
    const client = sessions[sessionId];

    if (!client?.connected) return res.status(400).json({ error: "❌ Session belum terhubung." });

    const jid = number.includes("@") ? number : `${number}@s.whatsapp.net`;

    try {
        await client.sock.sendMessage(jid, { text: message });
        res.json({ success: true, to: number });
    } catch (err) {
        console.error("❌ Gagal kirim pesan:", err);
        res.status(500).json({ error: "Gagal kirim pesan.", detail: err?.message });
    }
});

// ------------------- SOCKET.IO -------------------
io.on("connection", socket => {
    socket.on("join", sessionId => {
        socket.join(sessionId);
    });
});

// ------------------- SERVER -------------------
const PORT = 5000;
server.listen(PORT, () => {
    console.log(`🚀 ZahraBot MultiSession with WebSocket running on http://localhost:${PORT}`);
});
