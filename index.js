const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(require('cors')());

const jobs = {};

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
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job nao encontrado' });
  res.json(job);
});

app.post('/verify', async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'Imagem ausente' });
  const jobId = crypto.randomUUID();
  jobs[jobId] = { status: 'processing' };
  res.json({ jobId });
  runSearch(jobId, image);
});

async function runSearch(jobId, base64Image) {
  const tmpPath = path.join('/tmp', jobId + '.jpg');
  try {
    fs.writeFileSync(tmpPath, Buffer.from(base64Image, 'base64'));
    const results = await searchWithRetry(tmpPath, 3);
    jobs[jobId] = { status: 'done', ...results };
  } catch (err) {
    jobs[jobId] = { status: 'error', message: err.message };
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

async function searchWithRetry(filePath, attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await searchYandex(filePath);
    } catch (err) {
      console.log(`Tentativa ${i + 1} falhou:`, err.message);
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

async function searchYandex(filePath) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  try {
    // simula navegador real
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    await page.goto('https://yandex.ru/images/', { waitUntil: 'networkidle', timeout: 20000 });

    // pequena pausa para parecer humano
    await page.waitForTimeout(1500);

    // usa o seletor correto encontrado no diagnóstico
    const fileInput = await page.$('input.CbirCore-FileInput');
    if (!fileInput) throw new Error('Input CbirCore-FileInput nao encontrado');

    console.log('Seletor CbirCore-FileInput encontrado, fazendo upload...');
    await fileInput.setInputFiles(filePath);

    // aguarda a navegação para a página de resultados
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 });

    const url = page.url();
    console.log('URL apos upload:', url);

    // extrai resultados
    const results = await page.$$eval('.serp-item', els =>
      els.slice(0, 8).map(el => ({
        title: el.querySelector('.serp-item__title')?.innerText || '',
        url:   el.querySelector('a')?.href || '',
        site:  el.querySelector('.serp-item__domain')?.innerText || '',
      }))
    );

    // tenta seletores alternativos se serp-item nao encontrar nada
    let finalResults = results;
    if (results.length === 0) {
      finalResults = await page.$$eval('.CbirSites-Item, .cbir-sites__item', els =>
        els.slice(0, 8).map(el => ({
          title: el.querySelector('a')?.innerText || '',
          url:   el.querySelector('a')?.href || '',
          site:  el.querySelector('.CbirSites-ItemDomain, .cbir-sites__item-domain')?.innerText || '',
        }))
      );
      console.log('Resultados via seletor alternativo:', finalResults.length);
    }

    const count = finalResults.length;
    const score = count >= 5 ? 'high' : count >= 2 ? 'medium' : 'low';
    console.log('Score:', score, '| Resultados:', count);
    return { score, count, results: finalResults };
  } finally {
    await browser.close();
  }
}

app.listen(process.env.PORT || 3000, () => console.log('Rodando'));
