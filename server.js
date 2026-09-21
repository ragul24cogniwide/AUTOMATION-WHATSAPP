const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

dotenv.config();

const PORT = process.env.PORT || 3001;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const DATABASE_URL = process.env.DATABASE_URL;
const BACKEND_WEBHOOK_URL = process.env.BACKEND_WEBHOOK_URL || 'http://127.0.0.1:8006/api/whatsapp/webhook';
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER || '';

let sock = null;
let currentQR = null;
let isConnected = false;
let isConnecting = false;
let connectedUser = null;
let pool = null;
let lastUserChatJid = null;
const sentMessageIds = new Set();

// Initialize PostgreSQL connection pool if DATABASE_URL is set
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
}

/**
 * 1. Synchronize Session Keys with Neon PostgreSQL
 * Restores session from DB on startup so Render/local restarts NEVER log you out!
 */
async function syncAuthFromPostgres() {
  if (!pool) return;
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_auth_session (
        key VARCHAR(255) PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const res = await pool.query('SELECT key, data FROM whatsapp_auth_session');
    if (res.rows.length > 0) {
      console.log(`[Neon DB] Restoring ${res.rows.length} session credentials from database...`);
      for (const row of res.rows) {
        const filePath = path.join(AUTH_DIR, row.key);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, row.data, 'utf-8');
      }
      console.log('[Neon DB] Session credentials restored successfully.');
    }
  } catch (err) {
    console.warn('[Neon DB] Warning while restoring session from Postgres:', err.message);
  }
}

async function saveAuthToPostgres() {
  if (!pool || !fs.existsSync(AUTH_DIR)) return;
  try {
    const files = fs.readdirSync(AUTH_DIR);
    for (const file of files) {
      const filePath = path.join(AUTH_DIR, file);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const data = fs.readFileSync(filePath, 'utf-8');
        await pool.query(
          `INSERT INTO whatsapp_auth_session (key, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [file, data]
        );
      }
    }
  } catch (err) {
    console.warn('[Neon DB] Warning while saving session to Postgres:', err.message);
  }
}

/**
 * 2. Start Baileys WhatsApp Connection
 */
async function startWhatsApp() {
  if (isConnecting) {
    console.log('[WhatsApp Bridge] Connection attempt already in progress, skipping duplicate.');
    return;
  }
  isConnecting = true;

  // Clean up any existing socket cleanly before recreating
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      if (sock.ws) {
        try { sock.ws.close(); } catch (e) {}
      }
      sock.end();
    } catch (e) {}
    sock = null;
  }

  await syncAuthFromPostgres();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[WhatsApp Bridge] Using Baileys v${version.join('.')}, isLatest: ${isLatest}`);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Sage Assistant', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  });

  // Handle pairing code if configured and not registered
  if (PAIRING_PHONE_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const cleanNumber = PAIRING_PHONE_NUMBER.replace(/\D/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        console.log('\n==================================================');
        console.log(`👉 YOUR WHATSAPP PAIRING CODE IS: ${code}`);
        console.log(`Open WhatsApp on your phone > Linked Devices > Link with phone number instead`);
        console.log('==================================================\n');
      } catch (err) {
        console.error('Failed to request pairing code:', err.message);
      }
    }, 3000);
  }

  // Credentials updated event -> save to disk and Neon DB
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await saveAuthToPostgres();
  });

  // Connection status handler
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('\n--- SCAN THIS QR CODE IN WHATSAPP TO CONNECT ---');
      qrcodeTerminal.generate(qr, { small: true });
      console.log(`Or view the visual QR code in your browser at: http://localhost:${PORT}/qr\n`);
    }

    if (connection === 'close') {
      isConnected = false;
      isConnecting = false;
      connectedUser = null;

      const statusCode =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      const isConflict = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;
      const delayMs = isConflict ? 15000 : 3000;
      const reasonMsg = lastDisconnect?.error?.message || 'Unknown error';

      console.log(
        `[WhatsApp Bridge] Connection closed (statusCode: ${statusCode}, reason: ${reasonMsg}). Reconnecting: ${!isLoggedOut} in ${delayMs / 1000}s`
      );

      if (isConflict) {
        console.warn(
          '[WhatsApp Bridge] Note: If the bridge is also running on Render/cloud, ensure only ONE instance is active to avoid conflict!'
        );
      }

      if (!isLoggedOut) {
        // Automatically reconnect without clearing database session
        setTimeout(() => {
          startWhatsApp().catch((err) => {
            console.error('[WhatsApp Bridge] Reconnect error:', err.message);
          });
        }, delayMs);
      } else {
        console.log('[WhatsApp Bridge] Device logged out by user. Resetting session...');
        if (pool) {
          await pool.query('DELETE FROM whatsapp_auth_session').catch(() => null);
        }
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setTimeout(() => {
          startWhatsApp().catch((err) => {
            console.error('[WhatsApp Bridge] Restart after logout error:', err.message);
          });
        }, 3000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      isConnecting = false;
      currentQR = null;
      connectedUser = sock.user?.id || 'Connected';
      console.log('\n==================================================');
      console.log(`✅ WHATSAPP CONNECTED SUCCESSFULLY! (${connectedUser})`);
      console.log('Session synchronized permanently with Neon PostgreSQL.');
      console.log('==================================================\n');
      await saveAuthToPostgres();
    }
  });

  // Incoming Messages Handler
  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (!m.messages || m.messages.length === 0) return;
      const msg = m.messages[0];

      // Ignore broadcast status updates
      if (msg.key.remoteJid === 'status@broadcast') return;

      // Ignore messages sent by Sage itself to prevent echo/feedback loops
      if (msg.key?.id && sentMessageIds.has(msg.key.id)) {
        return;
      }

      const remoteJid = msg.key.remoteJid || '';
      const isFromMe = Boolean(msg.key.fromMe);
      const cleanPhone = remoteJid.split('@')[0].split(':')[0];
      const myPhone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
      const myLid = sock.user?.lid ? sock.user.lid.split(':')[0].split('@')[0] : '';
      const allowedPhone = (process.env.USER_PHONE || '918946014462').replace(/\D/g, '');

      // STRICT PRIVACY RULE: ONLY process messages from the user's self-chat!
      // NEVER intercept or reply to friends, family, or other contacts!
      const isSelfChat =
        cleanPhone === myPhone ||
        cleanPhone === myLid ||
        cleanPhone === allowedPhone ||
        remoteJid.includes(myPhone) ||
        (myLid && remoteJid.includes(myLid));

      if (!isSelfChat) {
        // Someone else messaged the user -> DO NOT INTERCEPT!
        return;
      }

      // Record the exact chat JID the user has open (whether it's @s.whatsapp.net or @lid)
      lastUserChatJid = remoteJid;

      // Detect text content
      let textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      // Detect voice note / audio
      let isVoice = false;
      let audioBase64 = null;
      let mimeType = 'text/plain';

      if (msg.message?.audioMessage) {
        isVoice = true;
        mimeType = msg.message.audioMessage.mimetype || 'audio/ogg';
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          if (buffer) {
            audioBase64 = buffer.toString('base64');
          }
        } catch (e) {
          console.warn('[WhatsApp Bridge] Could not download audio message:', e.message);
        }
      }

      // If there is no text and no audio, ignore
      if (!textContent && !audioBase64) return;

      const effectivePhone = myPhone || allowedPhone;
      console.log(
        `[WhatsApp Bridge] User message in ${remoteJid} | isVoice: ${isVoice} | text: "${textContent}"`
      );

      // Forward to Sage FastAPI backend
      const payload = {
        sender: `whatsapp:+${effectivePhone}`,
        text: textContent,
        is_voice: isVoice,
        audio_base64: audioBase64,
        mime_type: mimeType,
        from_me: isFromMe,
        remote_jid: remoteJid,
      };

      fetch(BACKEND_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(async (res) => {
          if (!res.ok) {
            console.warn(`[Backend Webhook] Server responded with status ${res.status}`);
          }
        })
        .catch((err) => {
          console.error(`[Backend Webhook] Could not forward to ${BACKEND_WEBHOOK_URL}:`, err.message);
        });
    } catch (err) {
      console.error('[WhatsApp Bridge] Error processing message:', err);
    }
  });
}

/**
 * 3. Express REST API for Outbound Messages & Health
 */
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Send Message Endpoint (called by Sage backend to dispatch reminders & daily briefings)
app.post('/send', async (req, res) => {
  try {
    const { to, message, remote_jid } = req.body;
    if (!to || !message) {
      return res.status(400).json({ error: 'Missing "to" or "message" in request body' });
    }

    if (!sock || !isConnected) {
      return res.status(503).json({
        error: 'WhatsApp is not connected yet. Please scan the QR code at /qr first.',
      });
    }

    let cleanDigits = to.replace(/\D/g, '');
    const myPhone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
    const myLid = sock.user?.lid ? sock.user.lid.split(':')[0].split('@')[0] : '';
    const allowedPhone = (process.env.USER_PHONE || '918946014462').replace(/\D/g, '');

    const isToUser =
      cleanDigits === '' ||
      cleanDigits === 'self' ||
      cleanDigits === myPhone ||
      cleanDigits === myLid ||
      cleanDigits === allowedPhone;

    // Send to the exact chat window (remote_jid or lastUserChatJid for self-chat)
    let jid;
    if (remote_jid) {
      jid = remote_jid;
    } else if (isToUser && lastUserChatJid) {
      jid = lastUserChatJid;
    } else if (isToUser) {
      jid = `${myPhone || allowedPhone}@s.whatsapp.net`;
    } else {
      jid = `${cleanDigits}@s.whatsapp.net`;
    }

    const result = await sock.sendMessage(jid, { text: message });

    // Track sent message ID so echo is not processed as a new incoming command
    if (result?.key?.id) {
      sentMessageIds.add(result.key.id);
      setTimeout(() => sentMessageIds.delete(result.key.id), 120000);
    }

    console.log(`[WhatsApp Bridge] Message dispatched to ${jid}`);
    return res.json({ status: 'sent', to: jid, id: result?.key?.id });
  } catch (err) {
    console.error('[WhatsApp Bridge] Error in /send:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: isConnected,
    user: connectedUser,
    neon_db_sync: Boolean(pool),
    backend_webhook: BACKEND_WEBHOOK_URL,
    timestamp: new Date().toISOString(),
  });
});

// Visual QR Code Web Page
app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <html>
        <body style="font-family: -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 90vh; background: #f8fafc;">
          <div style="background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center;">
            <div style="font-size: 50px;">✅</div>
            <h2 style="color: #0f172a; margin: 16px 0 8px 0;">WhatsApp Connected!</h2>
            <p style="color: #64748b; font-size: 14px;">Sage WhatsApp Bridge is active and synchronized with Neon PostgreSQL.</p>
          </div>
        </body>
      </html>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <html>
        <head><meta http-equiv="refresh" content="3"></head>
        <body style="font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 90vh; background: #f8fafc;">
          <div style="text-align: center;">
            <h3>Initializing WhatsApp Bridge...</h3>
            <p style="color: #64748b;">Generating QR code, page will refresh automatically...</p>
          </div>
        </body>
      </html>
    `);
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(currentQR);
    res.send(`
      <html>
        <head>
          <title>Connect Sage WhatsApp</title>
          <meta http-equiv="refresh" content="20">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 90vh; background: #f8fafc; margin: 0; padding: 20px;">
          <div style="background: white; padding: 36px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; max-width: 380px;">
            <div style="width: 48px; height: 48px; background: #0F172A; border-radius: 12px; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px auto; color: #818CF8; font-size: 24px; font-weight: bold;">✦</div>
            <h2 style="margin: 0 0 8px 0; color: #0F172A;">Connect Sage WhatsApp</h2>
            <p style="color: #64748B; font-size: 13px; line-height: 1.5; margin-bottom: 24px;">
              Open WhatsApp on your phone &gt; tap <b>Settings &gt; Linked Devices &gt; Link a Device</b> and scan this QR code.
            </p>
            <div style="padding: 12px; border: 1px solid #E2E8F0; border-radius: 12px; display: inline-block;">
              <img src="${qrDataUrl}" alt="WhatsApp QR Code" style="width: 250px; height: 250px; display: block;" />
            </div>
            <p style="color: #94A3B8; font-size: 11px; margin-top: 20px;">Page refreshes automatically. Session stays permanently in Neon DB.</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generating QR code image');
  }
});

app.get('/', (req, res) => {
  res.redirect('/qr');
});

// Start server
app.listen(PORT, () => {
  console.log(`[WhatsApp Bridge API] Server listening on port ${PORT}`);
  startWhatsApp().catch((err) => {
    console.error('[WhatsApp Bridge] Fatal error starting WhatsApp:', err);
  });
});
