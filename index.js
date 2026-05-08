const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();

// F-09: desabilitar X-Powered-By
app.disable('x-powered-by');

// F-05: CORS restrito ao domínio oficial
const cors = require('cors');
app.use(cors({
  origin: [
    'https://ifeitosa-cell.github.io',
    'http://localhost:3000',
    'null' // permite file:// local para desenvolvimento
  ],
  methods: ['GET', 'POST'],
  maxAge: 600
}));

// F-06: rate limiting em /verify — 10 req/min por IP
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Limite de 10 verificacoes por minuto atingido.' }
});

// F-06: rate limiting em /share — 20 req/min por IP
const shareLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'too_many_requests' }
});

app.use(express.json({ limit: '15mb' }));

const jobs = {};
const shares = {};

// F-15: endpoint /health dedicado
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
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/result/:id', (req, res) => {
  const id = req.params.id;
  // sanitiza o id — apenas hex e hífens
  if (!/^[a-f0-9\-]{6,36}$/.test(id)) {
    return res.status(400).json({ error: 'id_invalido' });
  }
  const job = jobs[id];
  if (!job) return res.status(404).json({ error: 'Job nao encontrado' });
  res.json(job);
});

// F-06 + F-14: verify com rate limit e validação server-side
app.post('/verify', verifyLimiter, async (req, res) => {
  const { image } = req.body;
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Imagem ausente' });
  }

  // F-14: valida tamanho server-side (base64 de 10MB = ~13.6MB de string)
  if (image.length > 14 * 1024 * 1024) {
    return res.status(400).json({ error: 'image_too_large' });
  }

  // F-14: valida magic bytes para garantir que é imagem real
  try {
    const buf = Buffer.from(image.slice(0, 16), 'base64');
    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
    const isPng  = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    // WEBP: bytes 0-3 = "RIFF", bytes 8-11 = "WEBP"
    const isWebp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
                   buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
    if (!isJpeg && !isPng && !isWebp) {
      return res.status(400).json({ error: 'invalid_image_type' });
    }
  } catch {
    return res.status(400).json({ error: 'invalid_base64' });
  }

  const jobId = crypto.randomUUID();
  jobs[jobId] = { status: 'processing' };
  res.json({ jobId });
  runSearch(jobId, image);
});

// rota para forçar busca direta no Bing
app.post('/verify-bing', verifyLimiter, async (req, res) => {
  const { image } = req.body;
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Imagem ausente' });
  }
  if (image.length > 14 * 1024 * 1024) {
    return res.status(400).json({ error: 'image_too_large' });
  }
  try {
    const buf = Buffer.from(image.slice(0, 16), 'base64');
    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
    const isPng  = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    const isWebp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
                   buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
    if (!isJpeg && !isPng && !isWebp) {
      return res.status(400).json({ error: 'invalid_image_type' });
    }
  } catch {
    return res.status(400).json({ error: 'invalid_base64' });
  }
  const jobId = crypto.randomUUID();
  jobs[jobId] = { status: 'processing' };
  res.json({ jobId });

  // roda busca apenas no Bing
  const tmpPath = path.join('/tmp', jobId + '.jpg');
  try {
    fs.writeFileSync(tmpPath, Buffer.from(image, 'base64'));
    const result = await searchWithRetry(tmpPath, 3, 'bing');
    jobs[jobId] = { status: 'done', engine: 'bing', ...result };
  } catch (err) {
    jobs[jobId] = { status: 'error', message: err.message };
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});
  const { result, imagePreview } = req.body;
  if (!result) return res.status(400).json({ error: 'Resultado ausente' });
  const shareId = crypto.randomBytes(6).toString('hex');
  shares[shareId] = {
    result,
    imagePreview: imagePreview || null,
    createdAt: new Date().toISOString()
  };
  res.json({ shareId });
});

app.get('/share/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{12}$/.test(id)) {
    return res.status(400).json({ error: 'id_invalido' });
  }
  const share = shares[id];
  if (!share) return res.status(404).json({ error: 'Link expirado ou invalido' });
  res.json(share);
});

async function runSearch(jobId, base64Image) {
  const tmpPath = path.join('/tmp', jobId + '.jpg');
  try {
    fs.writeFileSync(tmpPath, Buffer.from(base64Image, 'base64'));

    let result = null;
    let engine = 'yandex';
    try {
      result = await searchWithRetry(tmpPath, 3, 'yandex');
    } catch (yandexErr) {
      console.log('Yandex falhou, tentando Bing:', yandexErr.message);
      engine = 'bing';
      try {
        result = await searchWithRetry(tmpPath, 2, 'bing');
      } catch (bingErr) {
        throw new Error(`Yandex: ${yandexErr.message} | Bing: ${bingErr.message}`);
      }
    }

    if (result.count === 0 && engine === 'yandex') {
      console.log('Yandex sem resultados, tentando Bing...');
      try {
        const bingResult = await searchWithRetry(tmpPath, 2, 'bing');
        if (bingResult.count > 0) { engine = 'bing'; result = bingResult; }
      } catch (bingErr) {
        console.log('Bing também sem resultados:', bingErr.message);
      }
    }

    jobs[jobId] = { status: 'done', engine, ...result };
  } catch (err) {
    jobs[jobId] = { status: 'error', message: err.message };
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

async function searchWithRetry(filePath, attempts, engine) {
  for (let i = 0; i < attempts; i++) {
    try {
      return engine === 'bing'
        ? await searchBing(filePath)
        : await searchYandex(filePath);
    } catch (err) {
      console.log(`[${engine}] Tentativa ${i + 1} falhou:`, err.message);
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

// F-02 (server-side): sanitiza resultado antes de retornar ao front
function sanitizeResult(results) {
  return results.map(r => ({
    title: typeof r.title === 'string' ? r.title.slice(0, 300) : '',
    url:   isSafeHttpUrl(r.url) ? r.url : '',
    site:  typeof r.site === 'string' ? r.site.replace(/[<>"']/g, '').slice(0, 100) : '',
    thumb: isSafeHttpUrl(r.thumb) ? r.thumb : '',
  }));
}

function isSafeHttpUrl(input) {
  if (!input || typeof input !== 'string') return false;
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

async function searchYandex(filePath) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
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
      }))
    );

    if (results.length === 0) {
      results = await page.$$eval('.CbirSites-Item', els =>
        els.slice(0, 13).map(el => ({
          title: el.querySelector('.CbirSites-ItemTitle, a')?.innerText || '',
          url:   el.querySelector('a')?.href || '',
          site:  el.querySelector('.CbirSites-ItemDomain')?.innerText || '',
          thumb: el.querySelector('img')?.src || '',
        }))
      );
    }

    const thumbs = await page.$$eval(
      '.CbirOtherSizes-Item img, .other-sizes__item img, .cbir-similar__item img, .ImagesApp-SerpItem img',
      imgs => imgs.slice(0, 5).map(img => img.src || '')
    ).catch(() => []);

    const sanitized = sanitizeResult(results);
    const safeThumbs = thumbs.filter(isSafeHttpUrl);
    const count = sanitized.length;
    const verdict = count > 0 ? 'fake' : 'notfound';
    console.log('[yandex] verdict:', verdict, '| count:', count);
    return { verdict, count, results: sanitized, thumbs: safeThumbs };
  } finally {
    await browser.close();
  }
}

async function searchBing(filePath) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });

    await page.goto('https://www.bing.com/images/search?view=detailv2&iss=sbi', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);

    const seletores = ['input[type="file"]', '#sb_imgupload', '.bi_uploadFileInput'];
    let uploaded = false;
    for (const sel of seletores) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.setInputFiles(filePath);
          uploaded = true;
          break;
        }
      } catch (e) {
        console.log('[bing] seletor falhou:', sel, e.message);
      }
    }

    if (!uploaded) throw new Error('Nenhum seletor de upload encontrado no Bing');

    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 });
    console.log('[bing] URL:', page.url());

    const results = await page.$$eval('.richcap, .b_attribution, .iuscp', els =>
      els.slice(0, 13).map(el => ({
        title: el.querySelector('a')?.innerText || el.innerText || '',
        url:   el.querySelector('a')?.href || '',
        site:  el.querySelector('.trgr_icon ~ span, .ite_ip')?.innerText || '',
        thumb: el.closest('.iusc')?.querySelector('img')?.src || '',
      })).filter(r => r.url)
    ).catch(() => []);

    const thumbs = await page.$$eval(
      '.iusc img, .richImgLnk img',
      imgs => imgs.slice(0, 5).map(img => img.src || '')
    ).catch(() => []);

    const sanitized = sanitizeResult(results);
    const safeThumbs = thumbs.filter(isSafeHttpUrl);
    const count = sanitized.length;
    const verdict = count > 0 ? 'fake' : 'notfound';
    console.log('[bing] verdict:', verdict, '| count:', count);
    return { verdict, count, results: sanitized, thumbs: safeThumbs };
  } finally {
    await browser.close();
  }
}

app.listen(process.env.PORT || 3000, () => console.log('Rodando'));
