import html from '../public/index.html';

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
    // Upload PDF file
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      return await handleUpload(request, env);
    }

    // Import from cloud URL
    if (url.pathname === '/api/import' && request.method === 'POST') {
      return await handleImport(request, env);
    }

    // Job status
    const statusMatch = url.pathname.match(/^\/api\/status\/([a-f0-9-]+)$/);
    if (statusMatch && request.method === 'GET') {
      return await handleStatus(statusMatch[1], env);
    }

    // Download OCR PDF
    const dlMatch = url.pathname.match(/^\/api\/download\/([a-f0-9-]+)\/(pdf|docx)$/);
    if (dlMatch && request.method === 'GET') {
      return await handleDownload(dlMatch[1], dlMatch[2], env);
    }

    // View PDF inline
    const viewMatch = url.pathname.match(/^\/api\/view\/([a-f0-9-]+)$/);
    if (viewMatch && request.method === 'GET') {
      return await handleView(viewMatch[1], env);
    }

    // Callback from Render OCR service (status + file uploads)
    const cbMatch = url.pathname.match(/^\/api\/callback\/([a-f0-9-]+)$/);
    if (cbMatch && request.method === 'POST') {
      return await handleCallback(cbMatch[1], request, env);
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

  // Store in R2
  await env.BUCKET.put(`${jobId}/original.pdf`, buffer);
  await writeStatus(env, jobId, { status: 'queued', progress: 0 });

  // Trigger Render OCR service
  await triggerOcr(env, jobId, 'file');

  return json({ jobId });
}

// ── URL Import ──
async function handleImport(request, env) {
  const { url } = await request.json();
  if (!url) return json({ error: 'URL required' }, 400);

  const jobId = crypto.randomUUID();
  await writeStatus(env, jobId, { status: 'downloading', progress: 0 });

  // Render service will download the file, store in R2, and process
  const directUrl = resolveCloudUrl(url);
  await triggerOcr(env, jobId, 'url', directUrl);

  return json({ jobId });
}

// ── Status ──
async function handleStatus(jobId, env) {
  const obj = await env.BUCKET.get(`${jobId}/status.json`);
  if (!obj) return json({ error: 'Job not found' }, 404);
  const data = JSON.parse(await obj.text());
  return json(data);
}

// ── Download ──
async function handleDownload(jobId, type, env) {
  const key = type === 'pdf' ? `${jobId}/ocr.pdf` : `${jobId}/output.docx`;
  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ error: 'Not found' }, 404);

  const ct = type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const fn = type === 'pdf' ? 'ocr-result.pdf' : 'ocr-result.docx';

  return new Response(obj.body, {
    headers: {
      'Content-Type': ct,
      'Content-Disposition': `attachment; filename="${fn}"`,
    }
  });
}

// ── View PDF inline ──
async function handleView(jobId, env) {
  const obj = await env.BUCKET.get(`${jobId}/ocr.pdf`);
  if (!obj) return json({ error: 'Not found' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline',
    }
  });
}

// ── Callback from Render ──
async function handleCallback(jobId, request, env) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${env.OCR_API_KEY}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const contentType = request.headers.get('Content-Type') || '';

  // Status update (JSON)
  if (contentType.includes('application/json')) {
    const data = await request.json();
    if (data.status) {
      await writeStatus(env, jobId, data);
    }
    return json({ ok: true });
  }

  // File upload (multipart) — Render sends result files
  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();

    for (const [name, file] of formData.entries()) {
      if (file instanceof File) {
        const buffer = await file.arrayBuffer();
        await env.BUCKET.put(`${jobId}/${name}`, buffer);
      }
    }
    return json({ ok: true });
  }

  return json({ error: 'Bad request' }, 400);
}

// ── Trigger OCR on Render ──
async function triggerOcr(env, jobId, mode, url = null) {
  const payload = { jobId, mode };
  if (url) payload.url = url;

  // Fire and forget — don't await the full OCR, just the trigger
  try {
    const res = await fetch(`${env.OCR_SERVICE_URL}/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OCR_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('OCR trigger failed:', text);
      await writeStatus(env, jobId, { status: 'error', error: 'שגיאה בהפעלת שירות OCR' });
    }
  } catch (err) {
    console.error('OCR trigger error:', err);
    await writeStatus(env, jobId, { status: 'error', error: 'שירות OCR לא זמין' });
  }
}

// ── Cloud URL resolution ──
function resolveCloudUrl(url) {
  // Google Drive: /file/d/{id}/...
  const gdMatch = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (gdMatch) return `https://drive.google.com/uc?export=download&id=${gdMatch[1]}`;

  // Google Drive: open?id={id}
  if (url.includes('drive.google.com/open')) {
    try {
      const id = new URL(url).searchParams.get('id');
      if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    } catch {}
  }

  // Dropbox
  if (url.includes('dropbox.com')) {
    return url.replace('dl=0', 'dl=1').replace('www.dropbox.com', 'dl.dropboxusercontent.com');
  }

  // OneDrive
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

  const merged = {
    ...current,
    ...data,
    updatedAt: new Date().toISOString(),
  };

  if (!merged.createdAt) merged.createdAt = new Date().toISOString();
  if (!merged.expiresAt) {
    merged.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  await env.BUCKET.put(`${jobId}/status.json`, JSON.stringify(merged));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
