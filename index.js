// server.js – Baileys WhatsApp API (Render-ready)
// Node 18+ recommended
// Features:
// - /auth -> returns QR code as base64 data URL when not authenticated
// - /checkAuth -> returns auth/connection state
// - /sendMessage -> send a text message (option delete: true|false)
// - /sendButton -> send a template buttons message (option delete)
// - /sendList -> send a list message (option delete)
// - /delete -> delete a locally stored sent item by messageId (server-side only)
// - /sendViewOnceMedia -> send a view-once image/video/document
// - /markOnline -> mark presence "available" for a given duration
// - /markTyping -> mark "composing" for a given duration to a specific chat
// - Webhook forwarder: pushes incoming messages to WEBHOOK_URL; drops from memory on successful delivery
// - Auth persistence: stores session.json blob in Postgres (Render) and restores on boot
// - CORS enabled for all origins

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

const { default: makeWASocket, useSingleFileAuthState, Browsers, jidNormalizedUser, proto } = pkg

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------- ENV ----------
const PORT = process.env.PORT || 3000
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''
const DATABASE_URL = process.env.DATABASE_URL || ''
const SESSION_FILE = path.join(__dirname, 'session.json')

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
async function bootstrapSessionFile() {
  try {
    const dbBlob = await loadSessionFromDB()
    if (dbBlob) {
      fs.writeFileSync(SESSION_FILE, dbBlob, 'utf8')
      console.log('[Auth] Session restored from DB -> session.json')
    } else {
      // ensure file exists for first boot
      if (!fs.existsSync(SESSION_FILE)) fs.writeFileSync(SESSION_FILE, '{}', 'utf8')
      console.log('[Auth] No session in DB; starting fresh')
    }
  } catch (e) {
    console.error('[Auth bootstrap error]', e)
  }
}

// ---------- WhatsApp Socket ----------
let sock = null
let connectionState = {
  authenticated: false,
  connection: 'close', // 'open'|'close'|'connecting'
}
let latestQRDataURL = null

// Keep a lightweight store for sent messages and deletion flags
const sentStore = new Map() // messageId -> { type, payload }
const deleteOnDelivery = new Set() // messageId

function toJid(numberOrJid) {
  const raw = String(numberOrJid).trim()
  if (raw.includes('@')) return jidNormalizedUser(raw)
  // Expect E.164 without leading '+' (e.g., 226XXXXXXXX) — caller responsibility
  const onlyDigits = raw.replace(/\D/g, '')
  return `${onlyDigits}@s.whatsapp.net`
}

async function initSocket() {
  await ensureTables()
  await bootstrapSessionFile()

  const { state, saveState } = useSingleFileAuthState(SESSION_FILE)

  // Wrap saveState to also persist into DB
  const saveStateAndDB = async () => {
    try {
      await saveState()
      const blob = fs.readFileSync(SESSION_FILE, 'utf8')
      await saveSessionToDB(blob)
    } catch (e) {
      console.error('[Auth save error]', e)
    }
  }

  sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.appropriate('Desktop'),
    syncFullHistory: false,
  })

  // Persist creds when they change
  sock.ev.on('creds.update', saveStateAndDB)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
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
      const fromMe = !!msg.key?.fromMe
      if (fromMe) continue
      if (!WEBHOOK_URL) continue
      try {
        const payload = serializeMessage(msg)
        const res = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(`Webhook ${res.status}`)
        // success => nothing kept server-side
      } catch (e) {
        console.error('[Webhook] forward failed', e.message)
      }
    }
  })

  // Track delivery to apply delete-on-delivery
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const id = u.key?.id
      const status = u.update?.status
      // 3 = delivered to device, 4 = read (ACK codes)
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
  // Minimal payload; extend as needed
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
    else content = null
  } catch {}

  return { id, jid, fromMe, pushName, timestamp, type, content }
}

// ---------- Express App ----------
const app = express()
app.use(cors())
app.use(express.json({ limit: '25mb' }))

app.get('/', (_req, res) => res.json({ ok: true, name: 'Baileys WhatsApp API', version: 1 }))

// Auth: get QR (base64 data URL) if not authenticated
app.get('/auth', async (_req, res) => {
  try {
    if (connectionState.authenticated) {
      return res.json({ authenticated: true, connection: connectionState.connection })
    }
    if (!latestQRDataURL) {
      // Force a ping to trigger QR if needed
      try { await sock?.ws?.readyState } catch {}
    }
    return res.json({ authenticated: false, qr: latestQRDataURL })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/checkAuth', (_req, res) => {
  res.json({ authenticated: connectionState.authenticated, connection: connectionState.connection })
})

// Send text message
app.post('/sendMessage', async (req, res) => {
  try {
    const { number, jid, message, delete: del } = req.body || {}
    if (!message || (!number && !jid)) return res.status(400).json({ error: 'number/jid and message are required' })
    const to = jid ? toJid(jid) : toJid(number)
    const result = await sock.sendMessage(to, { text: message })
    const id = result?.key?.id
    sentStore.set(id, { type: 'text', payload: { to, message } })
    if (del) deleteOnDelivery.add(id)
    res.json({ ok: true, id, to })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Send buttons (template buttons)
app.post('/sendButton', async (req, res) => {
  try {
    const { number, jid, text, footer, buttons = [], delete: del } = req.body || {}
    if (!text || (!number && !jid)) return res.status(400).json({ error: 'number/jid and text are required' })
    const to = jid ? toJid(jid) : toJid(number)

    // Expect buttons as [{ id, text }]
    const templateButtons = buttons.slice(0, 3).map((b) => ({
      index: 1,
      quickReplyButton: { displayText: String(b.text || b.title || ''), id: String(b.id || b.value || `btn_${Math.random().toString(36).slice(2,8)}`) },
    }))

    const msg = {
      text,
      footer: footer || undefined,
      templateButtons,
    }

    const result = await sock.sendMessage(to, msg)
    const id = result?.key?.id
    sentStore.set(id, { type: 'buttons', payload: { to, text, buttons: templateButtons } })
    if (del) deleteOnDelivery.add(id)
    res.json({ ok: true, id, to })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Send list message
app.post('/sendList', async (req, res) => {
  try {
    const { number, jid, title, text, footer, buttonText = 'Select', sections = [], delete: del } = req.body || {}
    if (!text || (!number && !jid)) return res.status(400).json({ error: 'number/jid and text are required' })
    const to = jid ? toJid(jid) : toJid(number)

    // sections: [{ title, rows: [{ id, title, description }] }]
    const msg = {
      text,
      footer: footer || undefined,
      title: title || undefined,
      buttonText,
      sections: sections?.map((s) => ({
        title: s.title || '',
        rows: (s.rows || []).map((r) => ({ rowId: String(r.id || r.rowId || r.title), title: String(r.title || ''), description: r.description || undefined })),
      })),
    }

    const result = await sock.sendMessage(to, msg)
    const id = result?.key?.id
    sentStore.set(id, { type: 'list', payload: { to, msg } })
    if (del) deleteOnDelivery.add(id)
    res.json({ ok: true, id, to })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Delete locally stored message record (server-side only)
app.post('/delete', async (req, res) => {
  try {
    const { messageId } = req.body || {}
    if (!messageId) return res.status(400).json({ error: 'messageId required' })
    const existed = sentStore.delete(messageId)
    deleteOnDelivery.delete(messageId)
    res.json({ ok: true, removed: existed })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Send view-once media (image/video/document)
app.post('/sendViewOnceMedia', async (req, res) => {
  try {
    const { number, jid, caption, mediaUrl, mediaBase64, mimetype } = req.body || {}
    if ((!mediaUrl && !mediaBase64) || (!number && !jid)) return res.status(400).json({ error: 'number/jid and media are required' })
    const to = jid ? toJid(jid) : toJid(number)

    let buffer
    if (mediaBase64) {
      const base64 = mediaBase64.split(',').pop()
      buffer = Buffer.from(base64, 'base64')
    } else if (mediaUrl) {
      const r = await fetch(mediaUrl)
      if (!r.ok) return res.status(400).json({ error: `Failed to fetch media: ${r.status}` })
      buffer = Buffer.from(await r.arrayBuffer())
    }

    // Guess type by mimetype
    const isImage = (mimetype || '').startsWith('image/')
    const isVideo = (mimetype || '').startsWith('video/')

    let content
    if (isImage) content = { image: buffer, caption, viewOnce: true, mimetype }
    else if (isVideo) content = { video: buffer, caption, viewOnce: true, mimetype }
    else content = { document: buffer, caption, viewOnce: true, mimetype }

    const result = await sock.sendMessage(to, content)
    const id = result?.key?.id
    sentStore.set(id, { type: 'viewOnce', payload: { to, caption } })
    res.json({ ok: true, id, to })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Mark online for a duration (seconds)
app.post('/markOnline', async (req, res) => {
  try {
    const { durationSec = 10 } = req.body || {}
    await sock.sendPresenceUpdate('available')
    setTimeout(() => { sock.sendPresenceUpdate('unavailable').catch(() => {}) }, Math.max(0, Number(durationSec) * 1000))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Mark typing in a chat for a duration
app.post('/markTyping', async (req, res) => {
  try {
    const { number, jid, durationSec = 5 } = req.body || {}
    if (!number && !jid) return res.status(400).json({ error: 'number or jid required' })
    const to = jid ? toJid(jid) : toJid(number)
    await sock.presenceSubscribe(to)
    await sock.sendPresenceUpdate('composing', to)
    setTimeout(() => { sock.sendPresenceUpdate('paused', to).catch(() => {}) }, Math.max(0, Number(durationSec) * 1000))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------- Start ----------
initSocket().then(() => {
  app.listen(PORT, () => console.log(`HTTP listening on :${PORT}`))
}).catch((e) => {
  console.error('Fatal init error', e)
  process.exit(1)
})
