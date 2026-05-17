import { chromium } from 'playwright';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const SCREENSHOTS_DIR = path.resolve('docs/screenshots');

async function capture() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  console.log('🚀 Starting Vite dev server...');
  const devServer = spawn('npm', ['run', 'dev'], {
    cwd: path.resolve('apps/mini-app'),
    shell: true,
  });

  // Wait for dev server to be ready
  await new Promise((resolve) => {
    devServer.stdout.on('data', (data) => {
      if (data.toString().includes('Local:')) resolve();
    });
  });

  console.log('🌐 Launching browser...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 14 size
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

  const page = await context.newPage();
  const url = 'http://localhost:5173';

  try {
    console.log('📸 Capturing Home Screen...');
    await page.goto(url);

    // Mock API responses
    await page.route('**/health', route => route.fulfill({ json: { ok: true } }));
    await page.route('**/stats/today', route => route.fulfill({ 
      json: { reviewedToday: 42, dueCount: 154, streak: 12, learnedCount: 856 } 
    }));
    await page.route('**/stats/heatmap', route => route.fulfill({ 
      json: { history: Array.from({ length: 90 }, (_, i) => ({
        date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        count: Math.floor(Math.random() * 20)
      })) } 
    }));
    await page.route('**/questions/count', route => route.fulfill({ json: { unread: 3 } }));

    await page.reload(); // Reload to apply mocks
    await page.waitForSelector('.text-xl.font-bold'); 
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-home.png') });

    console.log('📸 Capturing Settings Sheet...');
    await page.click('button[aria-label="Настройки"]');
    await page.waitForSelector('h2:has-text("Настройки")');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-settings.png') });
    await page.click('button:has-text("Готово")');

    console.log('📸 Capturing Library...');
    await page.route('**/cards?limit=50', route => route.fulfill({ 
      json: [
        { id: '1', phrase: 'The Witcher', translation: 'Ведьмак', type: 'book', interval: 15 },
        { id: '2', phrase: 'Relic', translation: 'Реликвия', type: 'quote', interval: 4 },
        { id: '3', phrase: 'Alchemy', translation: 'Алхимия', type: 'type', interval: 30 }
      ] 
    }));
    await page.click('button:has-text("Карточки")');
    await page.waitForSelector('h1:has-text("Библиотека")');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-library.png') });
    await page.goBack();

    console.log('📸 Capturing Stats...');
    await page.route('**/stats/relics', route => route.fulfill({ 
      json: {
        relics: [
          { id: 'scroll', name: 'Манускрипт', unlocked: true, progress: 100 },
          { id: 'trophy', name: 'Трофей', unlocked: true, progress: 80 },
          { id: 'key', name: 'Ключ', unlocked: false, progress: 20 }
        ]
      } 
    }));
    await page.click('button:has-text("Статистика")');
    await page.waitForSelector('h1:has-text("Академический архив")');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-stats.png') });

    console.log('📸 Capturing Practice Session...');
    await page.goBack();
    await page.route('**/sessions/start', route => route.fulfill({ 
      json: {
        cards: [
          { id: '1', phrase: 'The Witcher', translation: 'Ведьмак', type: 'book', context: 'The Witcher is a monster hunter.' }
        ]
      } 
    }));
    await page.click('button:has-text("Начать сессию")');
    await page.waitForSelector('.relative.perspective-1000'); // Wait for card
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-practice.png') });

    console.log('✅ All screenshots captured in docs/screenshots/');
  } catch (err) {
    console.error('❌ Error during capture:', err);
  } finally {
    await browser.close();
    devServer.kill();
    process.exit(0);
  }
}

capture();
