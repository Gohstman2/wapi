// server.js – Baileys WhatsApp API (Render-ready, MultiFileAuthState)
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import P from 'pino'
import QRCode from 'qrcode'
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

// ---------- WhatsApp Socket ----------
let sock = null
let connectionState = { authenticated: false, connection: 'close' }
let latestQRDataURL = null
const sentStore = new Map()
const deleteOnDelivery = new Set()

function toJid(numberOrJid) {
  const raw = String(numberOrJid).trim()
  if (raw.includes('@')) return jidNormalizedUser(raw)
  const onlyDigits = raw.replace(/\D/g, '')
  return `${onlyDigits}@s.whatsapp.net`
}

async function initSocket() {
  await ensureTables()

  // Load session from DB if exists
  let savedState = null
  const dbBlob = await loadSessionFromDB()
  if (dbBlob) {
    savedState = JSON.parse(dbBlob)
    console.log('[Auth] Restoring state from DB')
  }

  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'))

  // Restore DB blob if exists
  if (savedState) Object.assign(state, savedState)

  sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.appropriate('Desktop'),
    syncFullHistory: false,
  })

  // Persist creds to disk and DB
  sock.ev.on('creds.update', async () => {
    await saveCreds()
    const blob = JSON.stringify(state)
    await saveSessionToDB(blob)
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQRDataURL = await QRCode.toDataURL(qr)
      connectionState.authenticated = false
      connectionState.connection = 'connecting'
    }

    if (connection) {
      connectionState.connection = connection
      if (connection === 'open') {
        connectionState.authenticated = true
        console.log('[WA] connection open')
      } else if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== 401
        console.log('[WA] connection closed', { shouldReconnect })
        connectionState.authenticated = false
        if (shouldReconnect) setTimeout(initSocket, 2000)
      }
    }
  })

  // Forward incoming messages to webhook
  sock.ev.on('messages.upsert', async (m) => {
    const msgs = m.messages || []
    for (const msg of msgs) {
      if (msg.key?.fromMe) continue
      if (!WEBHOOK_URL) continue
      try {
        const payload = serializeMessage(msg)
        const res = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(`Webhook ${res.status}`)
      } catch (e) {
        console.error('[Webhook] forward failed', e.message)
      }
    }
  })

  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const id = u.key?.id
      const status = u.update?.status
      if (id && deleteOnDelivery.has(id) && (status === 3 || status === 4)) {
        sentStore.delete(id)
        deleteOnDelivery.delete(id)
        console.log(`[Delete-on-delivery] removed local record ${id}`)
      }
    }
  })

  return sock
}

function serializeMessage(msg) {
  const jid = msg.key?.remoteJid || ''
  const id = msg.key?.id || ''
  const fromMe = !!msg.key?.fromMe
  const pushName = msg.pushName || ''
  const timestamp = Number(msg.messageTimestamp || msg.timestamp || Date.now())
  const type = Object.keys(msg.message || {})[0] || 'unknown'

  let content = null
  try {
    if (msg.message?.conversation) content = msg.message.conversation
    else if (msg.message?.extendedTextMessage?.text) content = msg.message.extendedTextMessage.text
    else if (msg.message?.imageMessage) content = { caption: msg.message.imageMessage.caption || null }
    else if (msg.message?.videoMessage) content = { caption: msg.message.videoMessage.caption || null }
  } catch {}

  return { id, jid, fromMe, pushName, timestamp, type, content }
}

// ---------- Express App ----------
const app = express()
app.use(cors())
app.use(express.json({ limit: '25mb' }))

app.get('/', (_req, res) => res.json({ ok: true, name: 'Baileys WhatsApp API', version: 1 }))

app.get('/auth', async (_req, res) => {
  try {
    if (connectionState.authenticated) return res.json({ authenticated: true, connection: connectionState.connection })
    return res.json({ authenticated: false, qr: latestQRDataURL })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/checkAuth', (_req, res) => res.json({ authenticated: connectionState.authenticated, connection: connectionState.connection }))

// ... Les autres routes sendMessage, sendButton, sendList, sendViewOnceMedia, delete, markOnline, markTyping restent inchangées et utilisent `sock` comme avant ...

// ---------- Start ----------
initSocket().then(() => {
  app.listen(PORT, () => console.log(`HTTP listening on :${PORT}`))
}).catch((e) => {
  console.error('Fatal init error', e)
  process.exit(1)
})
