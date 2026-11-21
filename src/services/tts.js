/**
 * Voiceover (text-to-speech). Gemini first (Interactions API, falling back to the
 * classic generateContent audio modality), OpenAI as an alternative. Output is
 * always a 16-bit PCM WAV buffer. Results are cached on disk by a hash of
 * (provider, model, voice, style, text), so re-recording a video costs nothing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../lib/util.js';

export const VOICES = [
  { id: 'Puck', label: 'Puck — upbeat' },
  { id: 'Kore', label: 'Kore — firm' },
  { id: 'Charon', label: 'Charon — informative' },
  { id: 'Fenrir', label: 'Fenrir — excitable' },
  { id: 'Leda', label: 'Leda — youthful' },
  { id: 'Aoede', label: 'Aoede — breezy' },
  { id: 'Gacrux', label: 'Gacrux — mature' },
  { id: 'Sulafat', label: 'Sulafat — warm' },
];
const OPENAI_VOICE = { Puck: 'nova', Kore: 'onyx', Charon: 'echo', Fenrir: 'fable', Leda: 'shimmer', Aoede: 'alloy', Gacrux: 'onyx', Sulafat: 'alloy' };

function wavFromPcm(pcm, sampleRate = 24000, channels = 1) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Duration in seconds of a PCM WAV (reads the fmt/data chunks). */
export function wavDuration(buf) {
  let off = 12;
  let byteRate = 48000;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') return Math.min(size, buf.length - off - 8) / byteRate;
    off += 8 + size + (size % 2);
  }
  return 0;
}

/** Find base64 audio anywhere in a provider response (shapes differ between APIs/versions). */
function findAudio(obj) {
  let best = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    const mime = o.mime_type || o.mimeType || '';
    if (typeof o.data === 'string' && o.data.length > 200 && (/audio/.test(mime) || !mime)) best = { data: o.data, mime };
    for (const v of Object.values(o)) walk(v);
  };
  walk(obj);
  return best;
}

function toWav(b64, mime) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.toString('ascii', 0, 4) === 'RIFF') return buf;
  const rate = Number(String(mime).match(/rate=(\d+)/)?.[1] || 24000);
  return wavFromPcm(buf, rate);
}

export class TTSService {
  constructor(env = process.env, { dataDir = './data', fetchImpl = globalThis.fetch } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.cacheDir = path.join(dataDir, 'audio');
    this.provider = env.GEMINI_API_KEY ? 'gemini' : env.OPENAI_API_KEY ? 'openai' : null;
    this.model = this.provider === 'gemini' ? env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts' : env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    this.lastError = null;
  }

  info() {
    return { available: !!this.provider, provider: this.provider, model: this.provider ? this.model : null, voices: VOICES, lastError: this.lastError };
  }

  async synthesize(text, { voice = 'Puck', style = '' } = {}) {
    if (!this.provider) throw new HttpError(409, 'Voiceover needs GEMINI_API_KEY or OPENAI_API_KEY');
    const clean = String(text || '').replace(/\{\{\s*link\s*\}\}/gi, '').trim();
    if (!clean) return null;
    const key = crypto.createHash('sha256').update(JSON.stringify([this.provider, this.model, voice, style, clean])).digest('hex').slice(0, 24);
    const file = path.join(this.cacheDir, `${key}.wav`);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    let wav;
    try {
      wav = this.provider === 'gemini' ? await this.gemini(clean, voice, style) : await this.openai(clean, voice, style);
      this.lastError = null;
    } catch (e) {
      this.lastError = { at: new Date().toISOString(), message: e.message };
      console.warn(`[tts] ${this.provider} failed: ${e.message}`);
      throw new HttpError(502, `Voiceover failed (${e.message}). ${/\b404\b/.test(e.message) ? `Set ${this.provider === 'gemini' ? 'GEMINI' : 'OPENAI'}_TTS_MODEL to a speech model your key can use.` : ''}`);
    }
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(file, wav);
    return wav;
  }

  async gemini(text, voice, style) {
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': this.env.GEMINI_API_KEY };
    // 1) Interactions API (current docs)
    const res = await this.fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        input: [{ type: 'user_input', content: [{ type: 'text', text, ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}) }] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice }] },
      }),
    });
    if (res.ok) {
      const audio = findAudio(await res.json());
      if (audio) return toWav(audio.data, audio.mime);
    }
    const firstStatus = res.status;
    // 2) Classic generateContent with the AUDIO response modality
    const res2 = await this.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text: style ? `Say in a ${style} way: ${text}` : text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    });
    if (!res2.ok) throw new Error(`gemini tts ${res2.status === 404 && firstStatus === 404 ? 404 : res2.status}`);
    const audio = findAudio(await res2.json());
    if (!audio) throw new Error('gemini tts returned no audio');
    return toWav(audio.data, audio.mime);
  }

  async openai(text, voice, style) {
    const res = await this.fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: this.model, voice: OPENAI_VOICE[voice] || 'alloy', input: text, response_format: 'wav', ...(style ? { instructions: `Speak in a ${style} tone.` } : {}) }),
    });
    if (!res.ok) throw new Error(`openai tts ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Voiceover for every storyboard scene of an asset. */
export async function assetVoiceover(tts, asset, { voice, style }) {
  const scenes = asset.content?.storyboard || [];
  const out = [];
  for (const s of scenes) {
    const wav = await tts.synthesize(s.vo, { voice, style });
    out.push({ scene: s.scene, start: s.start, end: s.end, duration: wav ? wavDuration(wav) : 0, audio: wav ? wav.toString('base64') : null });
  }
  return { voice, provider: tts.provider, model: tts.model, scenes: out };
}
