const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');

const app = express();
const PORT = process.env.PORT || 3000;
const TMP_DIR = path.join(__dirname, 'tmp');
const MAX_FILE_SIZE = 25 * 1024 * 1024;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.R2_BUCKET_NAME || 'pdf-ocr';

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', service: 'pdf-ocr-container' }));

app.post('/process', async (req, res) => {
  const { jobId, mode, url } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  res.json({ ok: true, jobId });

  const jobDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const startTime = Date.now();

  try {
    const inputFile = path.join(jobDir, 'original.pdf');

    if (mode === 'url') {
      await updateR2Status(jobId, { status: 'downloading', progress: 5 });
      await downloadFile(url, inputFile);

      const header = fs.readFileSync(inputFile).slice(0, 5).toString();
      if (!header.startsWith('%PDF')) {
        await updateR2Status(jobId, { status: 'error', error: 'הקובץ שהתקבל אינו PDF תקין' });
        cleanup(jobDir);
        return;
      }
      if (fs.statSync(inputFile).size > MAX_FILE_SIZE) {
        await updateR2Status(jobId, { status: 'error', error: 'הקובץ גדול מדי (מקסימום 25MB)' });
        cleanup(jobDir);
        return;
      }
      await putR2(`${jobId}/original.pdf`, fs.readFileSync(inputFile));
    } else {
      await updateR2Status(jobId, { status: 'processing', progress: 5 });
      const data = await getR2(`${jobId}/original.pdf`);
      fs.writeFileSync(inputFile, data);
    }

    await updateR2Status(jobId, { status: 'processing', progress: 15 });
    const { ocrFile, textFile } = await runOcr(jobDir, inputFile);

    await updateR2Status(jobId, { status: 'generating_docx', progress: 80 });
    const docxFile = await generateDocx(jobDir, textFile);

    await updateR2Status(jobId, { status: 'uploading', progress: 90 });
    await putR2(`${jobId}/ocr.pdf`, fs.readFileSync(ocrFile));
    if (docxFile && fs.existsSync(docxFile)) {
      await putR2(`${jobId}/output.docx`, fs.readFileSync(docxFile));
    }

    const originalSize = fs.existsSync(inputFile) ? fs.statSync(inputFile).size : 0;
    const ocrSize = fs.existsSync(ocrFile) ? fs.statSync(ocrFile).size : 0;
    const pageCount = await getPageCount(ocrFile);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    await updateR2Status(jobId, {
      status: 'done', progress: 100,
      fileSizeMB: (originalSize / 1024 / 1024).toFixed(1),
      ocrSizeMB: (ocrSize / 1024 / 1024).toFixed(1),
      pageCount,
      processingSeconds: elapsed,
    });

    // Trigger email notification
    await sendEmailNotification(jobId, {
      fileSizeMB: (originalSize / 1024 / 1024).toFixed(1),
      ocrSizeMB: (ocrSize / 1024 / 1024).toFixed(1),
      pageCount,
      processingSeconds: elapsed,
    });

    console.log(`Job ${jobId} completed — ${pageCount} pages, ${elapsed}s`);
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err);
    await updateR2Status(jobId, { status: 'error', error: 'שגיאה בעיבוד: ' + err.message });
  } finally {
    cleanup(jobDir);
  }
});

// ── OCR ──
function runOcr(jobDir, inputFile) {
  return new Promise((resolve, reject) => {
    const ocrFile = path.join(jobDir, 'ocr.pdf');
    const textFile = path.join(jobDir, 'text.txt');

    const cmd = [
      'ocrmypdf',
      '--language heb+eng',
      '--force-ocr',
      `--sidecar "${textFile}"`,
      '--optimize 1',
      '--jobs 2',
      `"${inputFile}" "${ocrFile}"`,
    ].join(' ');

    console.log(`Running OCR for ${path.basename(jobDir)}`);

    exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 600000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('OCR stderr:', stderr);
        return reject(new Error((stderr || err.message).slice(0, 300)));
      }
      resolve({ ocrFile, textFile });
    });
  });
}

// ── DOCX generation ──
async function generateDocx(jobDir, textFile) {
  if (!fs.existsSync(textFile)) return null;

  const text = fs.readFileSync(textFile, 'utf8');
  const paragraphs = text.split('\n').filter(l => l.trim()).map(line =>
    new Paragraph({
      children: [new TextRun({ text: line, font: 'David', size: 24 })],
      alignment: AlignmentType.RIGHT,
      bidirectional: true,
    })
  );

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children: paragraphs.length > 0 ? paragraphs : [
        new Paragraph({ children: [new TextRun('לא זוהה טקסט')] })
      ]
    }]
  });

  const outPath = path.join(jobDir, 'output.docx');
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// ── Page count ──
async function getPageCount(pdfFile) {
  if (!fs.existsSync(pdfFile)) return 0;
  return new Promise((resolve) => {
    exec(`grep -c "/Type\\s*/Page" "${pdfFile}"`, (err, stdout) => {
      const count = parseInt(stdout?.trim()) || 0;
      resolve(count > 0 ? count : 1);
    });
  });
}

// ── R2 helpers ──
async function getR2(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function putR2(key, body) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
}

async function updateR2Status(jobId, data) {
  let current = {};
  try {
    const existing = await getR2(`${jobId}/status.json`);
    current = JSON.parse(existing.toString());
  } catch {}

  const merged = { ...current, ...data, updatedAt: new Date().toISOString() };
  if (!merged.createdAt) merged.createdAt = new Date().toISOString();
  if (!merged.expiresAt) merged.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await putR2(`${jobId}/status.json`, Buffer.from(JSON.stringify(merged)));
}

// ── Email notification ──
async function sendEmailNotification(jobId, stats) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const base = 'https://pdf.yoffe.net';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'PDF OCR <gpx@mail.yoffe.net>',
        to: ['boaz.yoffe@gmail.com'],
        subject: `PDF OCR הושלם — ${stats.fileSizeMB}MB, ${stats.pageCount} עמודים`,
        html: `
          <div dir="rtl" style="font-family:Arial,sans-serif;max-width:500px">
            <h2 style="color:#4f46e5">PDF OCR הושלם בהצלחה</h2>
            <table style="border-collapse:collapse;width:100%">
              <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Job ID</b></td><td style="padding:6px;border-bottom:1px solid #eee;direction:ltr">${jobId}</td></tr>
              <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>גודל מקור</b></td><td style="padding:6px;border-bottom:1px solid #eee">${stats.fileSizeMB} MB</td></tr>
              <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>עמודים</b></td><td style="padding:6px;border-bottom:1px solid #eee">${stats.pageCount}</td></tr>
              <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>גודל OCR PDF</b></td><td style="padding:6px;border-bottom:1px solid #eee">${stats.ocrSizeMB} MB</td></tr>
              <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>זמן עיבוד</b></td><td style="padding:6px;border-bottom:1px solid #eee">${stats.processingSeconds} שניות</td></tr>
            </table>
            <div style="margin-top:16px">
              <a href="${base}/api/download/${jobId}/pdf" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:white;text-decoration:none;border-radius:8px;margin-left:8px">הורד PDF</a>
              <a href="${base}/api/download/${jobId}/docx" style="display:inline-block;padding:10px 20px;background:#2563eb;color:white;text-decoration:none;border-radius:8px">הורד DOCX</a>
            </div>
            <p style="color:#9ca3af;font-size:12px;margin-top:16px">הקבצים יימחקו אוטומטית בעוד 7 ימים</p>
          </div>
        `,
      }),
    });
  } catch (err) {
    console.error('Email send failed:', err);
  }
}

// ── Download from URL ──
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const client = url.startsWith('https') ? https : http;
      client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const stream = fs.createWriteStream(dest);
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_FILE_SIZE) {
            res.destroy(); stream.destroy();
            try { fs.unlinkSync(dest); } catch {}
            reject(new Error('File too large'));
          }
        });
        res.pipe(stream);
        stream.on('finish', () => stream.close(resolve));
        stream.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

app.listen(PORT, () => {
  console.log(`OCR container service running on port ${PORT}`);
});
