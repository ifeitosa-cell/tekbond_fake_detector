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

// diagnóstico do Bing — descobre seletores disponíveis
app.get('/diagnostico-bing', async (req, res) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    await page.goto('https://www.bing.com/images/search?view=detailv2&iss=sbi', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(2000);

    const url = page.url();
    const seletores = await page.$$eval(
      'input, button, [role="button"], label, [class*="upload"], [class*="file"], [class*="camera"], [id*="upload"], [id*="file"]',
      els => els.map(el => ({
        tag: el.tagName,
        type: el.type || '',
        id: el.id || '',
        className: el.className.substring(0, 120),
        name: el.name || '',
      }))
    );

    await browser.close();
    res.json({ url, seletores });
  } catch (err) {
    await browser.close();
    res.json({ erro: err.message });
  }
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
  if (!/^[a-f0-9\-]{6,36}$/.test(id)) return res.status(400).json({ error: 'id_invalido' });
  const job = jobs[id];
  if (!job) return res.status(404).json({ error: 'Job nao encontrado' });
  res.json(job);
});

function validateImage(image) {
  if (!image || typeof image !== 'string') return { error: 'Imagem ausente' };
  if (image.length > 14 * 1024 * 1024) return { error: 'image_too_large' };
  try {
    const buf = Buffer.from(image.slice(0, 16), 'base64');
    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
    const isPng  = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    const isWebp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
                   buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
    if (!isJpeg && !isPng && !isWebp) return { error: 'invalid_image_type' };
  } catch { return { error: 'invalid_base64' }; }
  return null;
}

app.post('/verify', verifyLimiter, async (req, res) => {
  const err = validateImage(req.body.image);
  if (err) return res.status(400).json(err);
  const jobId = crypto.randomUUID();
  jobs[jobId] = { status: 'processing' };
  res.json({ jobId });
  runSearch(jobId, req.body.image, null);
});

app.post('/verify-bing', verifyLimiter, async (req, res) => {
  const err = validateImage(req.body.image);
  if (err) return res.status(400).json(err);
  const jobId = crypto.randomUUID();
  jobs[jobId] = { status: 'processing' };
  res.json({ jobId });
  runSearch(jobId, req.body.image, 'bing');
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

async function runSearch(jobId, base64Image, forceEngine) {
  const tmpPath = path.join('/tmp', jobId + '.jpg');
  try {
    fs.writeFileSync(tmpPath, Buffer.from(base64Image, 'base64'));
    let result = null;
    let engine = forceEngine || 'yandex';

    if (forceEngine === 'bing') {
      result = await searchWithRetry(tmpPath, 3, 'bing');
    } else {
      try {
        result = await searchWithRetry(tmpPath, 3, 'yandex');
      } catch (yandexErr) {
        console.log('Yandex falhou, tentando Bing:', yandexErr.message);
        engine = 'bing';
        result = await searchWithRetry(tmpPath, 2, 'bing');
      }
      if (result.count === 0) {
        try {
          const bingResult = await searchWithRetry(tmpPath, 2, 'bing');
          if (bingResult.count > 0) { engine = 'bing'; result = bingResult; }
        } catch (e) {
          console.log('Bing sem resultados:', e.message);
        }
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
      return engine === 'bing' ? await searchBing(filePath) : await searchYandex(filePath);
    } catch (err) {
      console.log('[' + engine + '] Tentativa ' + (i+1) + ' falhou:', err.message);
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

function isSafeHttpUrl(input) {
  if (!input || typeof input !== 'string') return false;
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function sanitizeResult(results) {
  return results.map(r => ({
    title: typeof r.title === 'string' ? r.title.slice(0, 300) : '',
    url:   isSafeHttpUrl(r.url) ? r.url : '',
    site:  typeof r.site === 'string' ? r.site.replace(/[<>"']/g, '').slice(0, 100) : '',
    thumb: isSafeHttpUrl(r.thumb) ? r.thumb : '',
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
    const count = sanitized.length;
    console.log('[yandex] verdict:', count > 0 ? 'fake' : 'notfound', '| count:', count);
    return { verdict: count > 0 ? 'fake' : 'notfound', count, results: sanitized, thumbs: thumbs.filter(isSafeHttpUrl) };
  } finally {
    await browser.close();
  }
}

async function searchBing(filePath) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    await page.goto('https://www.bing.com/images/search?view=detailv2&iss=sbi', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(2000);

    // seletor confirmado pelo diagnóstico
    const fileInput = await page.$('#sb_fileinput');
    if (!fileInput) throw new Error('Seletor #sb_fileinput nao encontrado no Bing');

    console.log('[bing] seletor #sb_fileinput encontrado, fazendo upload...');
    await fileInput.setInputFiles(filePath);
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 });
    console.log('[bing] URL apos upload:', page.url());

    // aguarda resultados carregarem
    await page.waitForTimeout(2000);

    // extrai resultados de sites onde a imagem foi encontrada
    let results = await page.$$eval('.richcap, .b_attribution', els =>
      els.slice(0, 13).map(el => ({
        title: el.querySelector('a')?.innerText || el.innerText || '',
        url:   el.querySelector('a')?.href || '',
        site:  (() => { try { return new URL(el.querySelector('a')?.href || '').hostname; } catch(e) { return ''; } })(),
        thumb: el.closest('.iusc, .imgpt')?.querySelector('img')?.src || '',
      })).filter(r => r.url)
    ).catch(() => []);

    // fallback: tenta seletor alternativo
    if (results.length === 0) {
      results = await page.$$eval('.iusc', els =>
        els.slice(0, 13).map(el => {
          try {
            const m = el.getAttribute('m') || '{}';
            const data = JSON.parse(m);
            return {
              title: data.t || '',
              url:   data.purl || data.surl || '',
              site:  (() => { try { return new URL(data.purl || data.surl || '').hostname; } catch(e) { return ''; } })(),
              thumb: el.querySelector('img')?.src || '',
            };
          } catch(e) { return null; }
        }).filter(r => r && r.url)
      ).catch(() => []);
      console.log('[bing] resultados via .iusc:', results.length);
    }

    const thumbs = await page.$$eval(
      '.iusc img, .richImgLnk img',
      imgs => imgs.slice(0, 5).map(img => img.src || '')
    ).catch(() => []);

    const sanitized = sanitizeResult(results);
    const count = sanitized.length;
    console.log('[bing] verdict:', count > 0 ? 'fake' : 'notfound', '| count:', count);
    return { verdict: count > 0 ? 'fake' : 'notfound', count, results: sanitized, thumbs: thumbs.filter(isSafeHttpUrl) };
  } finally {
    await browser.close();
  }
}

app.listen(process.env.PORT || 3000, () => console.log('Rodando'));
