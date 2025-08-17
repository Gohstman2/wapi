import express from "express";
import dotenv from "dotenv";
import pkg from "@whiskeysockets/baileys";
const { default: makeWASocket, useSingleFileAuthState, Browsers } = pkg;
import P from "pino";

dotenv.config();
const app = express();
app.use(express.json());

const { state, saveState } = useSingleFileAuthState("./session.json");

// Création directe du socket
const sock = makeWASocket({
  auth: state,
  logger: P({ level: "info" }),
  browser: Browsers.macOS("Desktop"),
  getMessage: async () => ({ conversation: "message introuvable" }),
});

sock.ev.on("creds.update", saveState);

// Fonction pour attendre que la connexion soit ouverte
const waitForConnection = (phoneNumber) => {
  return new Promise((resolve, reject) => {
    let resolved = false;

    // Événement de mise à jour de connexion
    const handler = async (update) => {
      const { connection, qr } = update;

      if (connection === "open" && !resolved) {
        resolved = true;
        sock.ev.off("connection.update", handler);
        resolve({ status: "connected", phoneNumber });
      }
    };

    sock.ev.on("connection.update", handler);

    // Demande le pairing code (QR)
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
