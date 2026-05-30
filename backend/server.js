import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production (Railway), env vars are set directly. Locally, load from ../.env
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config(); // also try .env in cwd

const { webhookRouter } = await import('./routes/webhook.js');
const { oauthRouter } = await import('./routes/oauth.js');

const app = express();

// Webhook route needs raw body for signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use('/webhook', webhookRouter);
app.use('/auth', oauthRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`NiArgus backend running on port ${PORT}`));
