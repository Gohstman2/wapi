import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import P from 'pino'
import pkg from '@whiskeysockets/baileys'
import QRCode from 'qrcode'

const { default: makeWASocket, Browsers, proto } = pkg

const app = express()
app.use(cors())
app.use(express.json({ limit: '25mb' }))

const PORT = process.env.PORT || 3000

// Map numéro -> session info
const sessions = new Map() // number -> { sock, pairingCode, authenticated, connection }

function toJid(number) {
  const onlyDigits = String(number).replace(/\D/g, '')
  return `${onlyDigits}@s.whatsapp.net`
}

// Crée ou récupère un socket pour le numéro
async function getSocketForNumber(number) {
  let session = sessions.get(number)
  if (session && session.sock && session.connection === 'open') {
    return session
  }

  const pairingCode = Math.random().toString(36).slice(2, 8).toUpperCase()
  const sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {}, // pairing code auth
    browser: Browsers.appropriate('Desktop'),
    syncFullHistory: false,
  })

  let connectionState = { authenticated: false, connection: 'connecting' }
  sessions.set(number, { sock, pairingCode, ...connectionState })

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr } = update
    connectionState.connection = connection || connectionState.connection
    if (qr) {
      connectionState.authenticated = false
      sessions.set(number, { sock, pairingCode, ...connectionState })
    }
    if (connection === 'open') {
      connectionState.authenticated = true
      sessions.set(number, { sock, pairingCode: null, ...connectionState })
      console.log(`[${number}] Connected!`)
    } else if (connection === 'close') {
      connectionState.authenticated = false
      console.log(`[${number}] Disconnected`)
    }
  })

  return sessions.get(number)
}

// Route POST /auth -> on envoie le numéro, on reçoit pairing code
app.post('/auth', async (req, res) => {
  const { number } = req.body
  if (!number) return res.status(400).json({ error: 'number is required' })

  try {
    const session = await getSocketForNumber(number)
    res.json({
      number,
      authenticated: session.authenticated,
      connection: session.connection,
      pairingCode: session.authenticated ? null : session.pairingCode,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Route GET /checkAuth?number=xxxx -> état de connexion
app.get('/checkAuth', async (req, res) => {
  const number = req.query.number
  if (!number) return res.status(400).json({ error: 'number is required' })

  const session = sessions.get(number)
  if (!session) return res.json({ authenticated: false, connection: 'close' })

  res.json({
    number,
    authenticated: session.authenticated,
    connection: session.connection,
    pairingCode: session.authenticated ? null : session.pairingCode,
  })
})

app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
