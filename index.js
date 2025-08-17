// server.js – Baileys WhatsApp API (Pairing Code)
// Node 18+ recommended
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import P from 'pino'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import fetch from 'node-fetch'
import pkg from '@whiskeysockets/baileys'
import { Pool } from 'pg'

const { default: makeWASocket, useMultiFileAuthState, Browsers, jidNormalizedUser, proto } = pkg
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------- ENV ----------
const PORT = process.env.PORT || 3000
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''
const DATABASE_URL = process.env.DATABASE_URL || ''

// ---------- DB (Render Postgres) ----------
let pool = null
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
}

async function ensureTables() {
  if (!pool) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_state (
      id TEXT PRIMARY KEY,
      blob TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
}

async function loadSessionFromDB() {
  if (!pool) return null
  const { rows } = await pool.query('SELECT blob FROM whatsapp_state WHERE id = $1', ['session'])
  return rows[0]?.blob || null
}

async function saveSessionToDB(blob) {
  if (!pool) return
  await pool.query(
    `INSERT INTO whatsapp_state(id, blob) VALUES($1, $2)
     ON CONFLICT (id) DO UPDATE SET blob = EXCLUDED.blob, updated_at = NOW()`,
    ['session', blob]
  )
}

// ---------- Auth bootstrap ----------
let sock = null
let connectionState = { authenticated: false, connection: 'close' }
let latestPairingCode = null

async function initSocket() {
  await ensureTables()

  // MultiFileAuthState – auth persistence in folder
  const authFolder = path.join(__dirname, 'auth_info')
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(authFolder)

  sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.appropriate('Desktop'),
    syncFullHistory: false,
    pairingCode: true, // Enable pairing code flow
  })

  // Save session to DB when creds update
  sock.ev.on('creds.update', async () => {
    await saveCreds()
    // save auth blob to DB
    const blob = JSON.stringify(fs.readdirSync(authFolder))
    await saveSessionToDB(blob)
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, pairingCode } = update
    if (pairingCode) {
      latestPairingCode = pairingCode
      connectionState.authenticated = false
      connectionState.connection = 'connecting'
      console.log('[WA] Pairing code received:', pairingCode)
    }

    if (connection) {
      connectionState.connection = connection
      if (connection === 'open') {
        connectionState.authenticated = true
        console.log('[WA] Connection open')
      } else if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== 401
        connectionState.authenticated = false
        if (shouldReconnect) setTimeout(initSocket, 2000)
      }
    }
  })

  // Forward messages to webhook
  sock.ev.on('messages.upsert', async (m) => {
    const msgs = m.messages || []
    for (const msg of msgs) {
      if (!!msg.key?.fromMe) continue
      if (!WEBHOOK_URL) continue
      try {
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg)
        })
      } catch (e) {
        console.error('[Webhook] Error:', e.message)
      }
    }
  })
  return sock
}

// ---------- Express ----------
const app = express()
app.use(cors())
app.use(express.json())

app.get('/auth', (_req, res) => {
  if (connectionState.authenticated) return res.json({ authenticated: true, connection: connectionState.connection })
  res.json({ authenticated: false, pairingCode: latestPairingCode })
})

app.get('/checkAuth', (_req, res) => {
  res.json(connectionState)
})

// Example sendMessage
app.post('/sendMessage', async (req, res) => {
  try {
    const { number, message } = req.body
    if (!number || !message) return res.status(400).json({ error: 'number and message required' })
    const jid = jidNormalizedUser(`${number.replace(/\D/g, '')}@s.whatsapp.net`)
    const result = await sock.sendMessage(jid, { text: message })
    res.json({ ok: true, id: result.key.id, to: jid })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---------- Start ----------
initSocket().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
}).catch((e) => {
  console.error('Fatal init error', e)
  process.exit(1)
})
