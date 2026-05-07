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
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

async function searchYandex(filePath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto('https://yandex.ru/images/', { waitUntil: 'networkidle', timeout: 20000 });

    const seletores = [
      '[data-type="cbir"]',
      '.cbir-panel__file-input-label',
      'label[for="cbir-file-input"]',
      '.SearchForm-IconButton_type_cbir',
      'input[type="file"]',
    ];

    let clicou = false;
    for (const sel of seletores) {
      try {
        const el = await page.$(sel);
        if (el) {
          console.log('Seletor encontrado:', sel);
          if (sel === 'input[type="file"]') {
            await el.setInputFiles(filePath);
          } else {
            const [chooser] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 5000 }),
              el.click()
            ]);
            await chooser.setFiles(filePath);
          }
          clicou = true;
          break;
        }
      } catch (e) {
        console.log('Seletor falhou:', sel, e.message);
        continue;
      }
    }

    if (!clicou) {
      throw new Error('Nenhum seletor de upload encontrado no Yandex');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 });

    const results = await page.$$eval('.serp-item', els =>
      els.slice(0, 8).map(el => ({
        title: el.querySelector('.serp-item__title')?.innerText || '',
        url:   el.querySelector('a')?.href || '',
        site:  el.querySelector('.serp-item__domain')?.innerText || '',
      }))
    );

    const count = results.length;
    const score = count >= 5 ? 'high' : count >= 2 ? 'medium' : 'low';
    console.log('Score:', score, '| Resultados:', count);
    return { score, count, results };
  } finally {
    await browser.close();
  }
}

app.listen(process.env.PORT || 3000, () => console.log('Rodando'));
