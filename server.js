/**
 * Express backend (Gemini 2.5 Pro) with YouTube robustness + retry/backoff:
 * - Serves static frontend
 * - POST /upload accepts a file (multer 2.x) OR a YouTube URL + prompt
 * - If URL: downloads via yt-dlp (self-downloads binary if missing)
 * - Detects ffmpeg; adapts formats if merging isn't possible
 * - Uploads to Gemini File API, WAITS until ACTIVE (poll)
 * - Calls gemini-2.5-pro with generateContentStream
 * - Retries transient failures (503, 5xx, ETIMEDOUT/ECONNRESET)
 * - Streams chunks back to the client
 * - ALWAYS deletes temp files (local + Gemini) in finally
 */

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import morgan from 'morgan';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { lookup as mimeLookup } from 'mime-types';
import https from 'https';
import { spawn } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create job directory
const DATA_DIR = path.join(__dirname, 'data');
await fsp.mkdir(DATA_DIR, { recursive: true });
const JOB_DIR = path.join(DATA_DIR, 'jobs');
await fsp.mkdir(JOB_DIR, { recursive: true });

// Default system prompt used for analysis when user does not provide additional instructions
const DEFAULT_PROMPT = `Analyze this video and extract the following information:

METADATA EXTRACTION (Extract from any visible text, audio, or context):
- DATE: Any dates, times, or timestamps visible or mentioned
- ADDRESS/LOCATION: Street addresses, building names, landmarks, or location references
- CITY/STATE/COUNTY: Geographic location information
- POLICE DEPARTMENT: Agency names, officer badges, department identifiers, or jurisdiction

TIMESTAMP ANALYSIS (Extract timestamps for these categories):

1. 911 CALLS:
   - Emergency calls being made or received
   - Distress signals or calls for help
   - Emergency dispatcher communications
   - Critical emergency moments

2. CCTV FOOTAGE:
   - Suspicious activities or behaviors
   - People entering or leaving areas
   - Vehicle movements and activities
   - Security incidents or breaches
   - Unusual or notable events

3. INTERROGATION:
   - Questioning sessions or interviews
   - Confessions or admissions
   - Denials or evasive responses
   - Important statements or testimony
   - Emotional reactions during questioning

4. BODYCAM FOOTAGE:
   - Police officer interactions with civilians
   - Use of force incidents
   - Evidence collection moments
   - Procedural compliance or violations
   - Important statements or commands

5. INVESTIGATION:
   - Evidence discovery and collection
   - Crime scene analysis
   - Witness interviews
   - Key findings or breakthroughs
   - Case development moments

6. INTERROGATION (Additional):
   - Follow-up questioning sessions
   - Cross-examinations
   - Additional confessions or statements
   - Legal proceedings or hearings

FORMAT:
METADATA:
- Date: [extracted date/time information]
- Address/Location: [extracted location details]
- City/State/County: [extracted geographic information]
- Police Department: [extracted agency information]

TIMESTAMPS:
Format each timestamp as: [MM:SS - MM:SS] - [CATEGORY] - Description. Provide a start and end time for each event.
Additionally, in the textual label or description, include the range in parentheses after the category, e.g., 911 Call (00:45 - 01:00).

SUMMARY AND STORYLINE:
After extracting all timestamps, provide a comprehensive summary that explains:
- The overall narrative of the video
- Key events and their significance
- Timeline of important developments
- Main characters or subjects involved
- Conclusion or outcome

Be thorough in identifying moments that fit these specific categories and extract all visible metadata.`;

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY in .env');
  process.exit(1);
}

// Validate API key format (basic check)
if (GEMINI_API_KEY.length < 20) {
  console.error('❌ GEMINI_API_KEY appears to be invalid (too short)');
  process.exit(1);
}

// Production environment check
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) {
  console.log('🚀 Running in PRODUCTION mode');
} else {
  console.log('🔧 Running in DEVELOPMENT mode');
}

const app = express();

// Security headers and middleware
app.use((req, res, next) => {
  // Basic security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Request size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
if (isProduction) {
  app.use(morgan('combined'));
} else {
  app.use(morgan('dev'));
}
// Serve static files from project root (moved from /public)
app.use(express.static(__dirname));

// Shared files directory for linkable local video uploads
const SHARED_DIR = path.join(__dirname, 'shared');
await fsp.mkdir(SHARED_DIR, { recursive: true });
app.use('/shared', express.static(SHARED_DIR, { fallthrough: true, setHeaders: (res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
} }));

// -------- In-memory queue (runs in background) --------
const CONCURRENCY_LIMIT = 5;
let activeJobs = 0;
const jobQueue = []; // queue of { jobId, jobData }

// This is the new "run" function for the queue
async function runAnalysisJob(jobId, jobData) {
  const { localPath, prompt, fileUri, geminiFileName, cleanupPath } = jobData;

  const updateJobFile = async (data) => {
    const jobFilePath = path.join(JOB_DIR, `${jobId}.json`);
    try {
      const current = JSON.parse(await fsp.readFile(jobFilePath, 'utf8'));
      await fsp.writeFile(jobFilePath, JSON.stringify({ ...current, ...data }, null, 2));
    } catch (e) { 
      console.error(`Failed to update job file ${jobId}:`, e);
      // Try to write a minimal update if read fails
      try {
        await fsp.writeFile(jobFilePath, JSON.stringify({ ...jobData, ...data }, null, 2));
      } catch (e2) {
        console.error(`Critical: Cannot write job file ${jobId}:`, e2);
      }
    }
  };

  let uploadedFile = { file: { name: geminiFileName, uri: fileUri } };

  try {
    // Validate localPath exists
    if (!localPath) {
      throw new Error('Missing local file path for analysis');
    }

    // Check if file exists
    try {
      await fsp.access(localPath);
    } catch {
      throw new Error(`Local file not found: ${localPath}`);
    }

    // 1. (Optional) Upload to Gemini if not already done
    if (!uploadedFile.file.name && localPath) {
      await updateJobFile({ status: 'PROCESSING', progressLabel: 'Uploading to Gemini...' });
      
      const mimeType = getMimeType(localPath);
      if (!mimeType || mimeType === 'application/octet-stream') {
        console.warn(`Warning: Could not determine MIME type for ${localPath}, using video/mp4`);
      }
      
      uploadedFile = await fileManager.uploadFile(localPath, { 
        mimeType: mimeType || 'video/mp4', 
        displayName: path.basename(localPath) 
      });
      
      if (!uploadedFile?.file?.name) {
        throw new Error('Failed to upload file to Gemini. Please check file format and size.');
      }
      
      // Save the uploaded file name back to the job file
      await updateJobFile({ geminiFileName: uploadedFile.file.name });
    }

    // 2. Wait for ACTIVE
    await updateJobFile({ status: 'PROCESSING', progressLabel: 'Waiting for ACTIVE...' });
    const ready = await waitForActive(uploadedFile.file.name);
    const finalFileUri = ready.file?.uri || uploadedFile.file?.uri;
    if (!finalFileUri) throw new Error('Gemini did not return a file URI.');

    // 3. Stream generation
    await updateJobFile({ status: 'PROCESSING', progressLabel: 'Analyzing...' });
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' }, { timeout: 10 * 60 * 1000 }); // 10 min timeout
    
    const userQuery = (prompt || '').trim();
    let finalPrompt = DEFAULT_PROMPT;
    if (userQuery) {
      finalPrompt += `\n\nADDITIONAL USER INSTRUCTION:\n${userQuery}`;
    }

    const requestPayload = {
      contents: [{
        parts: [
          { text: finalPrompt },
          { fileData: { mimeType: getMimeType(localPath) || 'video/mp4', fileUri: finalFileUri } }
        ]
      }]
    };

    const streamResp = await streamWithRetry(model, requestPayload, {
      attempts: 5, // More retries for reliability
      initialDelayMs: 2000
    });

    let fullAnalysisText = '';
    for await (const chunk of streamResp.stream) {
      const text = chunk?.text?.() || '';
      if (text) fullAnalysisText += text;
    }

    if (!fullAnalysisText || fullAnalysisText.trim().length === 0) {
      throw new Error('Analysis completed but returned empty result. Please try again.');
    }

    // 4. Job Complete
    await updateJobFile({
      status: 'COMPLETE',
      progressLabel: 'Complete',
      analysisText: fullAnalysisText,
      geminiFileName: uploadedFile.file.name, // Save for final cleanup
      completedAt: new Date().toISOString()
    });

  } catch (e) {
    const errorMsg = e?.message || String(e);
    console.error(`Job ${jobId} failed:`, errorMsg);
    await updateJobFile({
      status: 'FAILED',
      progressLabel: 'Failed',
      analysisText: errorMsg,
      failedAt: new Date().toISOString()
    });
  } finally {
    // 5. Cleanup
    await deleteIfExists(cleanupPath); // Delete local temp file
    // We *keep* the Gemini file for now, in case of re-analysis.
    // We will delete it when the history item is deleted.

    // Signal queue that this job is done
    activeJobs -= 1;
    processQueue(); // Check for next job
  }
}

function processQueue() {
  while (activeJobs < CONCURRENCY_LIMIT && jobQueue.length > 0) {
    const { jobId, jobData } = jobQueue.shift();
    activeJobs += 1;

    // Run the job, but don't wait for it
    runAnalysisJob(jobId, jobData).catch(err => {
      console.error(`CRITICAL: Job ${jobId} failed outside runAnalysisJob:`, err);
      activeJobs -= 1;
      processQueue();
    });
  }
}

const TOTAL_STORAGE_BYTES = 20 * 1024 * 1024 * 1024; // 20GB

// ---------- New File-Based History API Functions ----------

// Helper to sanitize job ID (prevent path traversal)
function sanitizeJobId(jobId) {
  if (!jobId || typeof jobId !== 'string') return null;
  // Only allow alphanumeric characters, hyphens, and underscores
  const sanitized = String(jobId).replace(/[^a-zA-Z0-9_-]/g, '');
  // Prevent path traversal attempts
  if (sanitized.includes('..') || sanitized.includes('/') || sanitized.includes('\\')) {
    return null;
  }
  return sanitized;
}

// Helper to read a single job file
async function readJobFile(jobId) {
  try {
    const sanitizedId = sanitizeJobId(jobId);
    if (!sanitizedId) return null;
    const jobFilePath = path.join(JOB_DIR, `${sanitizedId}.json`);
    // Additional security: ensure path is within JOB_DIR (prevent path traversal)
    const resolvedPath = path.resolve(jobFilePath);
    const resolvedDir = path.resolve(JOB_DIR);
    if (!resolvedPath.startsWith(resolvedDir)) {
      console.warn(`Path traversal attempt detected: ${jobId}`);
      return null;
    }
    const data = await fsp.readFile(jobFilePath, 'utf8');
    return JSON.parse(data);
  } catch { return null; }
}

// Reads all .json files in the jobs directory
async function readAllHistory() {
  const files = await fsp.readdir(JOB_DIR);
  const jobs = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      const job = await readJobFile(file.replace('.json', ''));
      if (job) jobs.push(job);
    }
  }
  // newest first
  return jobs.sort((a, b) => (b.id || 0) - (a.id || 0));
}

// Calculates storage used by /shared files
async function getSharedStorageUsage() {
  let used = 0;
  try {
    const files = await fsp.readdir(SHARED_DIR);
    for (const file of files) {
      try {
        const stats = await fsp.stat(path.join(SHARED_DIR, file));
        used += stats.size;
      } catch {}
    }
  } catch {}
  return used;
}

// Keep-alive agent for outgoing HTTPS
import http from 'http';
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// Temp upload dir
const uploadDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'uploads-'));
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${ts}-${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
}).single('video');

// Separate multer for sharing local videos into shared directory
const shareStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SHARED_DIR),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `${ts}-${rand}${ext}`);
  }
});
const shareUpload = multer({ storage: shareStorage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }).single('file');

// ---------- helpers ----------

const isYouTubeUrl = (url) => {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === 'youtu.be';
  } catch {
    return false;
  }
};
const deleteIfExists = async (p) => { if (p) { try { await fsp.unlink(p); } catch {} } };
function getMimeType(filePath) { return mimeLookup(path.extname(filePath)) || 'application/octet-stream'; }

// ffmpeg detection (supports Windows, Linux, macOS)
async function hasFfmpeg() {
  const candidates = process.platform === 'win32' 
    ? [
        'ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(__dirname, 'ffmpeg.exe')
      ]
    : process.platform === 'darwin'
    ? ['ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']
    : [
        'ffmpeg',
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        path.join(__dirname, 'ffmpeg')
      ];
  
  for (const cmd of candidates) {
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(cmd, ['-version'], { timeout: 5000 });
        proc.on('error', reject);
        proc.on('close', code => (code === 0 ? resolve() : reject()));
        // Safety timeout
        setTimeout(() => {
          try { proc.kill(); } catch {}
          reject(new Error('ffmpeg check timeout'));
        }, 5000);
      });
      return { ok: true, path: cmd };
    } catch {}
  }
  return { ok: false };
}

// ---- yt-dlp presence (self-download if missing) ----
const YTDLP_BIN_DIR = path.join(os.tmpdir(), 'yt-dlp-bin');
await fsp.mkdir(YTDLP_BIN_DIR, { recursive: true });
const YTDLP_BIN_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : (process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp');
const YTDLP_BIN_PATH = path.join(YTDLP_BIN_DIR, YTDLP_BIN_NAME);

const YTDLP_RELEASE_URLS = {
  win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
};

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (resp) => {
      if (resp.statusCode && resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return downloadToFile(resp.headers.location, destPath).then(resolve).catch(reject);
      }
      if (resp.statusCode !== 200) {
        file.close(() => fs.unlink(destPath, () => {}));
        return reject(new Error(`Failed to download yt-dlp (HTTP ${resp.statusCode})`));
      }
      resp.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      file.close(() => fs.unlink(destPath, () => {}));
      reject(err);
    });
  });
}

async function which(cmd) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      try { await fsp.access(p, fs.constants.X_OK); return p; } catch {}
    }
  }
  return null;
}

async function ensureYtDlp() {
  // PATH first
  let bin = await which(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (bin) return bin;

  // Local cached binary
  if (!fs.existsSync(YTDLP_BIN_PATH)) {
    try {
    const url = YTDLP_RELEASE_URLS[process.platform] || YTDLP_RELEASE_URLS.linux;
      console.log(`Downloading yt-dlp from ${url}...`);
    await downloadToFile(url, YTDLP_BIN_PATH);
    if (process.platform !== 'win32') {
      await fsp.chmod(YTDLP_BIN_PATH, 0o755);
      }
      console.log(`✅ yt-dlp downloaded to ${YTDLP_BIN_PATH}`);
    } catch (e) {
      console.error(`Failed to download yt-dlp: ${e.message}`);
      throw new Error(`yt-dlp binary not found and download failed: ${e.message}`);
    }
  }
  return YTDLP_BIN_PATH;
}

function spawnPromise(bin, args, { collectStderr = true } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', collectStderr ? 'pipe' : 'inherit'], windowsHide: true, shell: false });
    if (collectStderr && proc.stderr) {
      proc.stderr.on('data', d => { stderr += d.toString(); });
    }
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve({ code, stderr }) : reject(new Error(`${bin} exited with code ${code}${stderr ? `\n${stderr}` : ''}`)));
  });
}

// Prefer progressive MP4; fallback to separate streams merge (needs ffmpeg)
function ytFormatArgs(ffmpegOk) {
  const args = [
    '--no-playlist',
    '--no-check-certificate',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best',
    '-S', 'ext:mp4:m4a,res,codec:avc1:acodec:aac'
  ];
  if (ffmpegOk) {
    args.push('--merge-output-format', 'mp4');
  } else {
    args[3] = 'b[ext=mp4]/best'; // progressive only if possible
  }
  return args;
}

// Robust YouTube download (returns created file path, whatever ext)
async function downloadYouTube(url, timeoutMs = 15 * 60 * 1000) {
  const bin = await ensureYtDlp();
  const ff = await hasFfmpeg();

  const outBase = path.join(os.tmpdir(), `yt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const outTpl = `${outBase}.%(ext)s`;
  const args = [ 
    url, 
    ...ytFormatArgs(ff.ok), 
    '-o', outTpl,
    '--no-warnings',
    '--quiet',
    '--no-progress'
  ];

  // Retry around EBUSY or transient spawn issues (common on Windows with AV scanners)
  let lastErr;
  const startTime = Date.now();
  
  for (let attempt = 1; attempt <= 4; attempt++) {
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      throw new Error('YouTube download timed out. Video may be too long or connection too slow.');
    }

    try {
      // Add timeout to spawnPromise for long videos
      await Promise.race([
        spawnPromise(bin, args),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Download timeout')), timeoutMs - (Date.now() - startTime))
        )
      ]);
      
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e).toLowerCase();
      
      // Check for common YouTube errors
      if (msg.includes('private') || msg.includes('unavailable') || msg.includes('sign in')) {
        throw new Error('This YouTube video is private, unavailable, or requires sign-in. Please use a public video.');
      }
      if (msg.includes('age restricted') || msg.includes('age-restricted')) {
        throw new Error('This YouTube video is age-restricted and cannot be downloaded.');
      }
      if (msg.includes('copyright') || msg.includes('blocked')) {
        throw new Error('This YouTube video is blocked due to copyright restrictions.');
      }
      
      const isBusy = (e?.code === 'EBUSY') || msg.includes('ebusy') || msg.includes('busy');
      if (attempt < 4 && isBusy) {
        // random small backoff (400-900ms)
        const delay = 300 + Math.floor(Math.random() * 700);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      // Clean up partial files on error
      try {
        const dirFiles = await fsp.readdir(path.dirname(outBase));
        for (const file of dirFiles) {
          if (file.startsWith(path.basename(outBase))) {
            await deleteIfExists(path.join(path.dirname(outBase), file));
          }
        }
      } catch {}
      
      throw new Error(`YouTube download failed: ${msg || e.message || 'Unknown error'}`);
    }
  }

  // Find the created file
  let created;
  try {
    const dirFiles = await fsp.readdir(path.dirname(outBase));
    created = dirFiles
    .map(name => path.join(path.dirname(outBase), name))
      .filter(p => {
        const basename = path.basename(p, path.extname(p));
        return basename.startsWith(path.basename(outBase));
      });
  } catch (e) {
    throw new Error(`Failed to find downloaded file: ${e.message}`);
  }

  if (!created.length) {
    throw new Error('yt-dlp finished but no output file was found. The video may be unavailable or in an unsupported format.');
  }

  // Verify file exists and has content
  try {
    const stats = await fsp.stat(created[0]);
    if (stats.size === 0) {
      await deleteIfExists(created[0]);
      throw new Error('Downloaded file is empty. The video may be corrupted or unavailable.');
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    throw new Error('Downloaded file not found after verification.');
  }

  return created[0]; // could be .mp4/.webm etc.
}

// ---------- Gemini ----------

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY, { agent: keepAliveAgent });
const fileManager = new GoogleAIFileManager(GEMINI_API_KEY, { agent: keepAliveAgent });
const MODEL = 'gemini-2.5-pro';

async function waitForActive(fileName, { timeoutMs = 10 * 60 * 1000, intervalMs = 3000 } = {}) {
  const start = Date.now();
  while (true) {
    const f = await fileManager.getFile(fileName);
    const state = f?.file?.state || f?.state;
    if (state === 'ACTIVE') return f;
    if (state === 'FAILED' || state === 'DELETED') throw new Error(`Gemini file state is ${state}; cannot proceed.`);
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for Gemini file to become ACTIVE (last state=${state ?? 'unknown'})`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

function isTransientError(err) {
  const msg = (err?.message || '').toLowerCase();
  const code = err?.status || err?.code || '';
  return (
    /503|500|502|504/.test(String(code)) ||
    msg.includes('503') || msg.includes('500') || msg.includes('502') || msg.includes('504') ||
    msg.includes('timed out') || msg.includes('timeout') ||
    msg.includes('ecconnreset') || msg.includes('etimedout') || msg.includes('econnrefused')
  );
}

async function streamWithRetry(model, request, { attempts = 3, initialDelayMs = 2000, onRetry = () => {} } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await model.generateContentStream(request);
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < attempts && isTransientError(err)) {
        const delay = initialDelayMs * Math.pow(2, i - 1);
        await onRetry(i + 1, delay, err);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ---------- endpoint ----------

app.post('/upload', (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ message: err.message || 'File upload error' });
    }

    try {
      const { url, prompt } = req.body || {};
      const hasFile = !!req.file;
      const hasUrl = !!url;

      // Input validation
      if (hasFile && hasUrl) {
        return res.status(400).json({ message: 'Provide either a video file OR a YouTube URL, not both.' });
      }
      if (!hasFile && !hasUrl) {
        return res.status(400).json({ message: 'Upload a video or provide a YouTube URL.' });
      }
      if (hasUrl) {
        if (typeof url !== 'string' || url.length > 2048) {
          return res.status(400).json({ message: 'Invalid URL format.' });
        }
        if (!isYouTubeUrl(url)) {
          return res.status(400).json({ message: 'URL must be a valid YouTube link.' });
        }
      }
      if (prompt && typeof prompt === 'string' && prompt.length > 5000) {
        return res.status(400).json({ message: 'Prompt exceeds maximum length of 5000 characters.' });
      }

      let localPath = null;
      let cleanupPath = null;
      let jobData = {};
      const jobId = Date.now();
      const jobFilePath = path.join(JOB_DIR, `${jobId}.json`);

      let videoUrlForHistory = url || null;
      let fileNameForHistory = req.file?.originalname || (url ? 'YouTube Video' : 'Analysis');
      
      // Sanitize filename
      if (fileNameForHistory && typeof fileNameForHistory === 'string') {
        fileNameForHistory = fileNameForHistory.replace(/[^\w.\- ]/g, '_').slice(0, 200);
      }

      try {
        // --- Step 1: Resolve local file path (This is fast) ---
        if (hasFile) {
          localPath = req.file.path;
          cleanupPath = localPath; // This temp file will be processed

        // Validate file size
        try {
          const stats = await fsp.stat(localPath);
          const maxSize = 2 * 1024 * 1024 * 1024; // 2GB
          if (stats.size > maxSize) {
            await deleteIfExists(cleanupPath);
            return res.status(413).json({ message: `File too large (${(stats.size / 1024 / 1024).toFixed(2)} MB). Maximum size is 2GB.` });
          }
          if (stats.size === 0) {
            await deleteIfExists(cleanupPath);
            return res.status(400).json({ message: 'Uploaded file is empty.' });
          }
        } catch (e) {
          await deleteIfExists(cleanupPath);
          return res.status(500).json({ message: 'Failed to validate uploaded file.' });
        }

        // We must *also* copy the file to /shared for history
        const shareFileName = `${jobId}-${req.file.filename}`;
        const shareFilePath = path.join(SHARED_DIR, shareFileName);
        try {
          await fsp.copyFile(localPath, shareFilePath);
          videoUrlForHistory = `/shared/${shareFileName}`;
        } catch (e) {
          console.error(`Failed to copy to shared: ${e.message}`);
          // Continue without shared copy - job can still proceed
          videoUrlForHistory = null;
        }

      } else if (hasUrl) {
        // For YouTube, we download it first. This is the only "blocking" part.
        // We can't queue a job without the file.
        try {
          localPath = await downloadYouTube(url);
          cleanupPath = localPath; // This temp file will be processed
          
          // Validate downloaded file
          try {
            const stats = await fsp.stat(localPath);
            const maxSize = 2 * 1024 * 1024 * 1024; // 2GB
            if (stats.size > maxSize) {
              await deleteIfExists(cleanupPath);
              return res.status(413).json({ message: `Downloaded video too large (${(stats.size / 1024 / 1024).toFixed(2)} MB). Maximum size is 2GB.` });
            }
          } catch (e) {
            await deleteIfExists(cleanupPath);
            return res.status(500).json({ message: 'Failed to validate downloaded video.' });
          }
          
          fileNameForHistory = path.basename(localPath);

          // We must also copy this to /shared for history
          const shareFileName = `${jobId}-${path.basename(localPath)}`;
          const shareFilePath = path.join(SHARED_DIR, shareFileName);
          try {
            await fsp.copyFile(localPath, shareFilePath);
            videoUrlForHistory = `/shared/${shareFileName}`;
          } catch (e) {
            console.error(`Failed to copy to shared: ${e.message}`);
            // Continue without shared copy - job can still proceed
            videoUrlForHistory = null;
          }

        } catch (e) {
          return res.status(500).json({ message: `YouTube download failed: ${e.message}` });
        }
      }

        // --- Step 2: Create the job file (History Item) ---
        jobData = {
          id: jobId,
          name: fileNameForHistory,
          status: 'QUEUED',
          progressLabel: 'Queued',
          analysisText: '',
          videoUrl: videoUrlForHistory,
          fileName: fileNameForHistory,
          geminiFileName: null, // Will be set after upload
          createdAt: new Date().toISOString(),

          // Data for the worker
          localPath,
          cleanupPath,
          prompt,
        };

        await fsp.writeFile(jobFilePath, JSON.stringify(jobData, null, 2));

        // --- Step 3: Add to queue and respond immediately ---
        jobQueue.push({ jobId, jobData });
        processQueue();

        res.status(202).json({ jobId: jobId });

      } catch (e) {
        console.error('Error in upload handler:', e);
        await deleteIfExists(cleanupPath); // Clean up if we failed before queuing
        res.status(500).json({ message: e?.message || 'Failed to queue job' });
      }
    } catch (outerErr) {
      console.error('Outer error in upload handler:', outerErr);
      res.status(500).json({ message: 'Internal server error' });
    }
  });
});

// Share endpoint: accepts a local video file and returns a public URL under /shared
app.post('/share/upload', (req, res) => {
  shareUpload(req, res, (err) => {
    if (err) {
      const message = err?.message || 'Share upload failed';
      return res.status(400).json({ message });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'Missing file' });
    }
    const publicUrl = `/shared/${encodeURIComponent(req.file.filename)}`;
    return res.json({ url: publicUrl });
  });
});

// Endpoint for frontend to poll job status
app.get('/api/job/status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = sanitizeJobId(id);
    if (!sanitizedId) {
      return res.status(400).json({ message: 'Invalid job ID' });
    }
    const job = await readJobFile(sanitizedId);
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }
    // Return the job file, cleaning sensitive paths
    const { localPath, cleanupPath, ...jobData } = job;
    res.json(jobData);
  } catch (e) {
    console.error('Get job status error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---------- New File-Based History API ----------

app.get('/api/history', async (req, res) => {
  const items = await readAllHistory();
  res.json(items);
});

app.get('/api/history/storage', async (req, res) => {
  const used = await getSharedStorageUsage();
  res.json({ used, total: TOTAL_STORAGE_BYTES });
});

// This endpoint is no longer used, but we keep it to avoid 404s
app.post('/api/history', (req, res) => {
  res.status(400).json({ message: 'History is now created via /upload' });
});

app.put('/api/history/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = sanitizeJobId(id);
    if (!sanitizedId) {
      return res.status(400).json({ message: 'Invalid job ID' });
    }
    
    const { name } = req.body || {};
    
    // Validate and sanitize name
    let sanitizedName = null;
    if (name && typeof name === 'string') {
      sanitizedName = name.trim().slice(0, 200); // Max 200 chars
      if (sanitizedName.length === 0) sanitizedName = null;
    }
    
    const job = await readJobFile(sanitizedId);
    if (!job) return res.status(404).json({ message: 'Not found' });

    if (sanitizedName) job.name = sanitizedName;
    
    const jobFilePath = path.join(JOB_DIR, `${sanitizedId}.json`);
    // Security check: ensure path is within JOB_DIR
    const resolvedPath = path.resolve(jobFilePath);
    const resolvedDir = path.resolve(JOB_DIR);
    if (!resolvedPath.startsWith(resolvedDir)) {
      return res.status(400).json({ message: 'Invalid path' });
    }
    
    await fsp.writeFile(jobFilePath, JSON.stringify(job, null, 2));
    res.json(job);
  } catch (e) { 
    console.error('Update job error:', e);
    res.status(500).json({ message: e?.message || 'Failed to update' }); 
  }
});

app.delete('/api/history/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = sanitizeJobId(id);
    if (!sanitizedId) {
      return res.status(400).json({ message: 'Invalid job ID' });
    }
    
    const jobFilePath = path.join(JOB_DIR, `${sanitizedId}.json`);
    // Security check: ensure path is within JOB_DIR
    const resolvedPath = path.resolve(jobFilePath);
    const resolvedDir = path.resolve(JOB_DIR);
    if (!resolvedPath.startsWith(resolvedDir)) {
      return res.status(400).json({ message: 'Invalid path' });
    }
    
    const job = await readJobFile(sanitizedId);
    if (!job) return res.status(404).json({ message: 'Not found' });

    // *** FIX STORAGE LEAK ***
    // 1. Delete associated /shared/ file (with path validation)
    if (job.videoUrl && job.videoUrl.startsWith('/shared/')) {
      try {
        const shareFileName = decodeURIComponent(job.videoUrl.replace('/shared/', ''));
        // Sanitize filename to prevent path traversal
        const safeFileName = path.basename(shareFileName);
        const shareFilePath = path.join(SHARED_DIR, safeFileName);
        const resolvedSharePath = path.resolve(shareFilePath);
        const resolvedShareDir = path.resolve(SHARED_DIR);
        if (resolvedSharePath.startsWith(resolvedShareDir)) {
          await deleteIfExists(shareFilePath);
        }
      } catch (e) {
        console.warn('Error deleting shared file:', e);
      }
    }

    // 2. Delete Gemini file
    if (job.geminiFileName && typeof job.geminiFileName === 'string') {
      try { 
        await fileManager.deleteFile(job.geminiFileName); 
      } catch (e) {
        console.warn('Error deleting Gemini file:', e);
      }
    }

    // 3. Delete the job.json file
    await fsp.unlink(jobFilePath);

    res.json({ ok: true });
  } catch (e) { 
    console.error('Delete job error:', e);
    res.status(500).json({ message: e?.message || 'Failed to delete' }); 
  }
});

// Root
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Periodic cleanup: remove old temp files and job files
async function cleanupOldFiles() {
  try {
    // Clean temp files older than 24 hours
    const tempDir = os.tmpdir();
    const files = await fsp.readdir(tempDir);
    const now = Date.now();
    for (const file of files) {
      if (file.startsWith('yt-') || file.startsWith('uploads-')) {
        try {
          const filePath = path.join(tempDir, file);
          const stats = await fsp.stat(filePath);
          const age = now - stats.mtimeMs;
          if (age > 24 * 60 * 60 * 1000) { // 24 hours
            await deleteIfExists(filePath);
          }
        } catch {}
      }
    }

    // Clean old job files (keep last 100)
    const jobFiles = await fsp.readdir(JOB_DIR);
    const jobs = [];
    for (const file of jobFiles) {
      if (file.endsWith('.json')) {
        try {
          const job = await readJobFile(file.replace('.json', ''));
          if (job) jobs.push({ id: job.id, file: file });
        } catch {}
      }
    }
    jobs.sort((a, b) => (b.id || 0) - (a.id || 0));
    // Keep last 100, delete older ones
    if (jobs.length > 100) {
      for (let i = 100; i < jobs.length; i++) {
        try {
          const job = await readJobFile(jobs[i].id);
          if (job && (job.status === 'COMPLETE' || job.status === 'FAILED')) {
            // Only delete completed/failed jobs older than 7 days
            const createdAt = new Date(job.createdAt || 0).getTime();
            const age = now - createdAt;
            if (age > 7 * 24 * 60 * 60 * 1000) { // 7 days
              await deleteIfExists(path.join(JOB_DIR, jobs[i].file));
              // Also clean up associated shared file
              if (job.videoUrl && job.videoUrl.startsWith('/shared/')) {
                const shareFileName = decodeURIComponent(job.videoUrl.replace('/shared/', ''));
                await deleteIfExists(path.join(SHARED_DIR, shareFileName));
              }
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    console.error('Cleanup error:', e);
  }
}

// Run cleanup every 6 hours
setInterval(cleanupOldFiles, 6 * 60 * 60 * 1000);
// Run once on startup
cleanupOldFiles();

const server = app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  console.log(`📁 Job directory: ${JOB_DIR}`);
  console.log(`📁 Shared directory: ${SHARED_DIR}`);
  console.log(`⚙️  Concurrency limit: ${CONCURRENCY_LIMIT}`);
});
server.headersTimeout = 60 * 1000;
server.requestTimeout = 0;
