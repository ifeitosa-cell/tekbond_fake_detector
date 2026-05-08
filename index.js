const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.disable('x-powered-by');

app.use(cors({
  origin: ['https://ifeitosa-cell.github.io', 'http://localhost:3000', 'null'],
  methods: ['GET', 'POST'],
  maxAge: 600
}));

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests' }
});

const shareLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { error: 'too_many_requests' }
});

app.use(express.json({ limit: '15mb' }));

const jobs = {};
const shares = {};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/test-playwright', async (req, res) => {
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://yandex.ru/images/', { waitUntil: 'networkidle', timeout: 15000 });
    const title = await page.title();
    await browser.close();
    res.json({ ok: true, title });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/result/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9\-]{6,36}$/.test(id)) return res.status(400).json({ error: 'id_invalido' });
  const job = jobs[id];
  if (!job) return res.status(404).json({ error: 'Job nao encontrado' });
  res.json(job);
});

function getMimeFromBase64(base64) {
  try {
    const buf = Buffer.from(base64.slice(0, 16), 'base64');
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
    return null;
  } catch { return null; }
}

function validateImage(image) {
  if (!image || typeof image !== 'string') return { error: 'Imagem ausente' };
  if (image.length > 14 * 1024 * 1024) return { error: 'image_too_large' };
  if (!getMimeFromBase64(image)) return { error: 'invalid_image_type' };
  return null;
}

app.post('/verify', verifyLimiter, async (req, res) => {
  const err = validateImage(req.body.image);
  if (err) return res.status(400).json(err);
  const jobId = crypto.randomUUID();
  jobs[jobId] = { status: 'processing' };
  res.json({ jobId });
  runSearch(jobId, req.body.image);
});

// URL pública temporária para abrir no Lens manualmente
app.post('/lens-url', verifyLimiter, (req, res) => {
  const err = validateImage(req.body.image);
  if (err) return res.status(400).json(err);
  const mime = getMimeFromBase64(req.body.image);
  const ext  = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const id   = crypto.randomBytes(16).toString('hex');
  const tmpPath = path.join('/tmp', `lens_${id}.${ext}`);
  try {
    fs.writeFileSync(tmpPath, Buffer.from(req.body.image, 'base64'));
  } catch (e) {
    return res.status(500).json({ error: 'Erro ao salvar imagem temporária' });
  }
  const timer = setTimeout(() => {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }, 90000);
  if (timer.unref) timer.unref();
  const imageUrl = `https://tekbondfakedetector-production.up.railway.app/img/${id}.${ext}`;
  const lensUrl  = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
  res.json({ lensUrl, imageUrl });
});

// Serve imagem temporária
app.get('/img/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-f0-9]{32}\.(jpg|jpeg|png|webp)$/.test(filename)) return res.status(400).send('Invalid');
  const filePath = path.join('/tmp', `lens_${filename}`);
  if (!fs.existsSync(filePath)) return res.status(404).send('Imagem expirada');
  const ext = filename.split('.').pop();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  res.setHeader('Content-Type', mimeMap[ext] || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=90');
  res.sendFile(filePath);
});

app.post('/share', shareLimiter, (req, res) => {
  const { result, imagePreview } = req.body;
  if (!result) return res.status(400).json({ error: 'Resultado ausente' });
  const shareId = crypto.randomBytes(6).toString('hex');
  shares[shareId] = { result, imagePreview: imagePreview || null, createdAt: new Date().toISOString() };
  res.json({ shareId });
});

app.get('/share/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{12}$/.test(id)) return res.status(400).json({ error: 'id_invalido' });
  const share = shares[id];
  if (!share) return res.status(404).json({ error: 'Link expirado ou invalido' });
  res.json(share);
});

// ── BUSCA PRINCIPAL: Yandex + Google Lens em paralelo ──
async function runSearch(jobId, base64Image) {
  const tmpYandex = path.join('/tmp', `${jobId}_y.jpg`);
  const tmpLens   = path.join('/tmp', `${jobId}_l.jpg`);
  try {
    fs.writeFileSync(tmpYandex, Buffer.from(base64Image, 'base64'));
    fs.writeFileSync(tmpLens,   Buffer.from(base64Image, 'base64'));

    // roda os dois em paralelo
    const [yandexResult, lensResult] = await Promise.allSettled([
      searchWithRetry(tmpYandex, 3, 'yandex'),
      searchWithRetry(tmpLens,   2, 'lens'),
    ]);

    const y = yandexResult.status === 'fulfilled' ? yandexResult.value : null;
    const l = lensResult.status   === 'fulfilled' ? lensResult.value   : null;

    if (yandexResult.status === 'rejected') console.log('[yandex] falhou:', yandexResult.reason?.message);
    if (lensResult.status   === 'rejected') console.log('[lens]   falhou:', lensResult.reason?.message);

    // combina resultados e deduplica por domínio
    const allResults = dedup([...(y?.results || []), ...(l?.results || [])]);
    const allThumbs  = dedup([...(y?.thumbs  || []), ...(l?.thumbs  || [])], true);

    const count   = allResults.length;
    const verdict = count > 0 ? 'fake' : 'notfound';
    const engines = [y ? 'yandex' : null, l ? 'lens' : null].filter(Boolean);

    console.log(`[combined] verdict: ${verdict} | count: ${count} | engines: ${engines.join('+')}`);
    jobs[jobId] = { status: 'done', verdict, count, results: allResults, thumbs: allThumbs, engines };
  } catch (err) {
    jobs[jobId] = { status: 'error', message: err.message };
  } finally {
    for (const f of [tmpYandex, tmpLens]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
}

// deduplica por hostname — prioriza resultados com thumb
function dedup(items, urlOnly = false) {
  const seen = new Set();
  return items.filter(item => {
    const key = urlOnly ? item : (() => {
      try { return new URL(item.url || '').hostname; } catch { return item.url || Math.random(); }
    })();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function searchWithRetry(filePath, attempts, engine) {
  for (let i = 0; i < attempts; i++) {
    try {
      return engine === 'lens'
        ? await searchGoogleLens(filePath)
        : await searchYandex(filePath);
    } catch (err) {
      console.log(`[${engine}] tentativa ${i+1} falhou:`, err.message);
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

function isSafeHttpUrl(input) {
  if (!input || typeof input !== 'string') return false;
  try { const u = new URL(input); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

function sanitizeResult(results) {
  return results.map(r => ({
    title: typeof r.title === 'string' ? r.title.slice(0, 300) : '',
    url:   isSafeHttpUrl(r.url)   ? r.url   : '',
    site:  typeof r.site === 'string' ? r.site.replace(/[<>"']/g, '').slice(0, 100) : '',
    thumb: isSafeHttpUrl(r.thumb) ? r.thumb : '',
    source: r.source || 'yandex',
  }));
}

async function searchYandex(filePath) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    });
    await page.goto('https://yandex.ru/images/', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);
    const fileInput = await page.$('input.CbirCore-FileInput');
    if (!fileInput) throw new Error('Seletor CbirCore-FileInput nao encontrado');
    await fileInput.setInputFiles(filePath);
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 });
    console.log('[yandex] URL:', page.url());
    let results = await page.$$eval('.serp-item', els =>
      els.slice(0, 13).map(el => ({
        title: el.querySelector('.serp-item__title')?.innerText || '',
        url:   el.querySelector('a')?.href || '',
        site:  el.querySelector('.serp-item__domain')?.innerText || '',
        thumb: el.querySelector('img')?.src || '',
        source: 'yandex',
      }))
    );
    if (results.length === 0) {
      results = await page.$$eval('.CbirSites-Item', els =>
        els.slice(0, 13).map(el => ({
          title: el.querySelector('.CbirSites-ItemTitle, a')?.innerText || '',
          url:   el.querySelector('a')?.href || '',
          site:  el.querySelector('.CbirSites-ItemDomain')?.innerText || '',
          thumb: el.querySelector('img')?.src || '',
          source: 'yandex',
        }))
      );
    }
    const thumbs = await page.$$eval(
      '.CbirOtherSizes-Item img, .other-sizes__item img, .cbir-similar__item img, .ImagesApp-SerpItem img',
      imgs => imgs.slice(0, 5).map(img => img.src || '')
    ).catch(() => []);
    const sanitized = sanitizeResult(results);
    console.log('[yandex] count:', sanitized.length);
    return { count: sanitized.length, results: sanitized, thumbs: thumbs.filter(isSafeHttpUrl) };
  } finally {
    await browser.close();
  }
}

async function searchGoogleLens(filePath) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    });

    await page.goto('https://lens.google.com/', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);

    // upload
    const fileInputs = await page.$$('input[type="file"]');
    if (fileInputs.length === 0) throw new Error('Input de arquivo nao encontrado no Lens');
    await fileInputs[0].setInputFiles(filePath);
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(2000);
    console.log('[lens] URL apos upload:', page.url());

    // navega para correspondências exatas (udm=48)
    const textos = ['Correspondências exatas', 'Exact matches', 'Coincidencias exactas'];
    let clicou = false;
    for (const texto of textos) {
      try {
        const el = page.getByText(texto, { exact: true });
        if (await el.isVisible({ timeout: 3000 })) {
          await el.click();
          await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1500);
          clicou = true;
          console.log('[lens] clicou em:', texto);
          break;
        }
      } catch {}
    }

    // fallback: força udm=48 na URL
    if (!clicou) {
      let url = page.url();
      url = url.includes('udm=') ? url.replace(/udm=\d+/, 'udm=48') : url + (url.includes('?') ? '&' : '?') + 'udm=48';
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1500);
      console.log('[lens] fallback udm=48:', url);
    }

    // extrai resultados — tenta múltiplos seletores conhecidos do Lens
    let results = [];

    // seletor 1: cards de sites com correspondência
    results = await page.$$eval('a[data-ved][jsname][href*="http"]', els =>
      els.slice(0, 13).map(el => {
        const img = el.querySelector('img');
        return {
          title: el.getAttribute('aria-label') || el.innerText?.trim() || '',
          url:   el.href || '',
          site:  (() => { try { return new URL(el.href).hostname; } catch { return ''; } })(),
          thumb: img?.src || '',
          source: 'lens',
        };
      }).filter(r => r.url && r.url.startsWith('http') && !r.url.includes('google.com'))
    ).catch(() => []);

    // seletor 2: g-card ou divs de resultado
    if (results.length === 0) {
      results = await page.$$eval('.Vd9M6 a, .cHaqb a, .GZnQqe a, [data-action-url] a', els =>
        els.slice(0, 13).map(el => {
          const card = el.closest('[data-action-url]') || el.closest('.Vd9M6') || el.closest('.cHaqb');
          const img  = card?.querySelector('img');
          return {
            title: el.innerText?.trim() || el.getAttribute('aria-label') || '',
            url:   el.href || '',
            site:  (() => { try { return new URL(el.href).hostname; } catch { return ''; } })(),
            thumb: img?.src || '',
            source: 'lens',
          };
        }).filter(r => r.url && r.url.startsWith('http') && !r.url.includes('google.com'))
      ).catch(() => []);
    }

    // seletor 3: qualquer link externo na página de resultados
    if (results.length === 0) {
      results = await page.$$eval('a[href]', els =>
        els.slice(0, 50).map(el => ({
          title: el.innerText?.trim().slice(0, 100) || '',
          url:   el.href || '',
          site:  (() => { try { return new URL(el.href).hostname; } catch { return ''; } })(),
          thumb: '',
          source: 'lens',
        })).filter(r =>
          r.url.startsWith('http') &&
          !r.url.includes('google.com') &&
          !r.url.includes('gstatic.com') &&
          r.site.length > 3
        ).slice(0, 13)
      ).catch(() => []);
    }

    // thumbnails de imagens similares
    const thumbs = await page.$$eval(
      '.wETe9b img, .YQ4gaf img, .fR600b img',
      imgs => imgs.slice(0, 5).map(img => img.src || '').filter(s => s.startsWith('http'))
    ).catch(() => []);

    const sanitized = sanitizeResult(results);
    console.log('[lens] count:', sanitized.length);
    return { count: sanitized.length, results: sanitized, thumbs };
  } finally {
    await browser.close();
  }
}

app.listen(process.env.PORT || 3000, () => console.log('Rodando'));
