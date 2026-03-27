import html from '../public/index.html';
import { Container, getContainer } from '@cloudflare/containers';

export class OcrContainer extends Container {
  defaultPort = 3000;

  sleepAfter = '5m';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleApi(request, url, env) {
  try {
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      return await handleUpload(request, env);
    }

    if (url.pathname === '/api/import' && request.method === 'POST') {
      return await handleImport(request, env);
    }

    const statusMatch = url.pathname.match(/^\/api\/status\/([a-f0-9-]+)$/);
    if (statusMatch && request.method === 'GET') {
      return await handleStatus(statusMatch[1], env);
    }

    const dlMatch = url.pathname.match(/^\/api\/download\/([a-f0-9-]+)\/(pdf|docx)$/);
    if (dlMatch && request.method === 'GET') {
      return await handleDownload(dlMatch[1], dlMatch[2], env);
    }

    const viewMatch = url.pathname.match(/^\/api\/view\/([a-f0-9-]+)$/);
    if (viewMatch && request.method === 'GET') {
      return await handleView(viewMatch[1], env);
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) {
    console.error('API error:', err);
    return json({ error: err.message }, 500);
  }
}

// ── Upload ──
async function handleUpload(request, env) {
  const formData = await request.formData();
  const file = formData.get('pdf');
  if (!file) return json({ error: 'No file' }, 400);
  if (file.size > 25 * 1024 * 1024) return json({ error: 'File too large (max 25MB)' }, 400);

  const buffer = await file.arrayBuffer();
  const header = new TextDecoder().decode(buffer.slice(0, 5));
  if (!header.startsWith('%PDF')) return json({ error: 'Not a valid PDF' }, 400);

  const jobId = crypto.randomUUID();

  await env.BUCKET.put(`${jobId}/original.pdf`, buffer);
  await writeStatus(env, jobId, { status: 'queued', progress: 0 });

  // Send to OCR container
  await triggerOcr(env, jobId, 'file');

  return json({ jobId });
}

// ── URL Import ──
async function handleImport(request, env) {
  const { url } = await request.json();
  if (!url) return json({ error: 'URL required' }, 400);

  const jobId = crypto.randomUUID();
  await writeStatus(env, jobId, { status: 'downloading', progress: 0 });

  const directUrl = resolveCloudUrl(url);
  await triggerOcr(env, jobId, 'url', directUrl);

  return json({ jobId });
}

// ── Status ──
async function handleStatus(jobId, env) {
  const obj = await env.BUCKET.get(`${jobId}/status.json`);
  if (!obj) return json({ error: 'Job not found' }, 404);
  return json(JSON.parse(await obj.text()));
}

// ── Download ──
async function handleDownload(jobId, type, env) {
  const key = type === 'pdf' ? `${jobId}/ocr.pdf` : `${jobId}/output.docx`;
  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ error: 'Not found' }, 404);

  const ct = type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const fn = type === 'pdf' ? 'ocr-result.pdf' : 'ocr-result.docx';

  return new Response(obj.body, {
    headers: { 'Content-Type': ct, 'Content-Disposition': `attachment; filename="${fn}"` }
  });
}

// ── View PDF inline ──
async function handleView(jobId, env) {
  const obj = await env.BUCKET.get(`${jobId}/ocr.pdf`);
  if (!obj) return json({ error: 'Not found' }, 404);

  return new Response(obj.body, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline' }
  });
}

// ── Trigger OCR via Container ──
async function triggerOcr(env, jobId, mode, url = null) {
  try {
    const container = getContainer(env.OCR_CONTAINER);
    const payload = { jobId, mode };
    if (url) payload.url = url;

    // Fire and forget — container processes in background
    const res = await container.fetch('http://container/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('OCR trigger failed:', text);
      await writeStatus(env, jobId, { status: 'error', error: 'שגיאה בהפעלת שירות OCR' });
    }
  } catch (err) {
    console.error('OCR trigger error:', err);
    await writeStatus(env, jobId, { status: 'error', error: 'שירות OCR לא זמין — נסה שוב בעוד דקה' });
  }
}

// ── Cloud URL resolution ──
function resolveCloudUrl(url) {
  const gdMatch = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (gdMatch) return `https://drive.google.com/uc?export=download&id=${gdMatch[1]}`;

  if (url.includes('drive.google.com/open')) {
    try {
      const id = new URL(url).searchParams.get('id');
      if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    } catch {}
  }

  if (url.includes('dropbox.com')) {
    return url.replace('dl=0', 'dl=1').replace('www.dropbox.com', 'dl.dropboxusercontent.com');
  }

  if (url.includes('onedrive.live.com')) {
    return url.replace('redir?', 'download?');
  }

  return url;
}

// ── Helpers ──
async function writeStatus(env, jobId, data) {
  const existing = await env.BUCKET.get(`${jobId}/status.json`);
  let current = {};
  if (existing) {
    try { current = JSON.parse(await existing.text()); } catch {}
  }

  const merged = { ...current, ...data, updatedAt: new Date().toISOString() };
  if (!merged.createdAt) merged.createdAt = new Date().toISOString();
  if (!merged.expiresAt) merged.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await env.BUCKET.put(`${jobId}/status.json`, JSON.stringify(merged));
}

// ── Email notification ──
async function sendNotificationEmail(env, jobId, data) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return;

  const base = 'https://pdf.yoffe.net';
  const sizeMB = data.fileSizeMB || '?';
  const pages = data.pageCount || '?';
  const ocrSizeMB = data.ocrSizeMB || '?';
  const processingTime = data.processingSeconds || '?';

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'PDF OCR <gpx@mail.yoffe.net>',
        to: ['boaz.yoffe@gmail.com'],
        subject: `PDF OCR הושלם — ${sizeMB}MB, ${pages} עמודים`,
        html: `
          <div dir="rtl" style="font-family:Arial,sans-serif;max-width:500px">
            <h2 style="color:#4f46e5">PDF OCR הושלם בהצלחה</h2>
            <table style="border-collapse:collapse;width:100%">
              <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Job ID</b></td><td style="padding:6px;border-bottom:1px solid #eee;direction:ltr">${jobId}</td></tr>
              <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>גודל מקור</b></td><td style="padding:6px;border-bottom:1px solid #eee">${sizeMB} MB</td></tr>
              <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>עמודים</b></td><td style="padding:6px;border-bottom:1px solid #eee">${pages}</td></tr>
              <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>גודל OCR PDF</b></td><td style="padding:6px;border-bottom:1px solid #eee">${ocrSizeMB} MB</td></tr>
              <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>זמן עיבוד</b></td><td style="padding:6px;border-bottom:1px solid #eee">${processingTime} שניות</td></tr>
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
