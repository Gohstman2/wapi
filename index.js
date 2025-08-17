import express from "express";
import dotenv from "dotenv";
import pkg from "@whiskeysockets/baileys";
import P from "pino";

const { default: makeWASocket, useMultiFileAuthState, Browsers } = pkg;

dotenv.config();
const app = express();
app.use(express.json());

let sock;

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("./session");

  sock = makeWASocket({
    auth: state,
    logger: P({ level: "info" }),
    browser: Browsers.macOS("Desktop"),
    getMessage: async () => ({ conversation: "message introuvable" }),
  });

  sock.ev.on("creds.update", saveCreds);
};

// Lance la socket au démarrage
startSock();

// Fonction pour attendre que la connexion soit ouverte
const waitForConnection = (phoneNumber) => {
  return new Promise((resolve, reject) => {
    if (!sock) return reject("Socket non initialisé");

    let resolved = false;

    const handler = async (update) => {
      const { connection } = update;

      if (connection === "open" && !resolved) {
        resolved = true;
        sock.ev.off("connection.update", handler);
        resolve({ status: "connected", phoneNumber });
      }
    };

    sock.ev.on("connection.update", handler);

    sock.requestPairingCode(phoneNumber).catch((err) => {
      if (!resolved) {
        resolved = true;
        sock.ev.off("connection.update", handler);
        reject(err);
      }
    });
  });
};

// Endpoint pour demander un code de couplage
app.post("/pair", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "Numéro requis" });

  try {
    const result = await waitForConnection(phoneNumber);
    res.json({ message: "Connexion établie ✅", ...result });
  } catch (err) {
    console.error("Erreur:", err);
    res.status(500).json({ error: "Impossible de se connecter" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur en ligne sur le port ${PORT}`));
