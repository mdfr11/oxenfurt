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
  const devServer = spawn('pnpm', ['dev'], {
    cwd: path.resolve('apps/mini-app'),
    shell: true,
  });

  await new Promise((resolve) => {
    devServer.stdout.on('data', (data) => {
      if (data.toString().includes('Local:')) resolve();
    });
  });

  console.log('🌐 Launching browser...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

  await context.addInitScript(() => {
    window.localStorage.clear();
    const settings = {
      nativeLanguage: 'en',
      learningLanguage: 'en',
      soundEnabled: true,
      hapticsEnabled: true,
      aiGradingEnabled: true
    };
    window.localStorage.setItem('oxenfurt_settings', JSON.stringify(settings));
    window.localStorage.setItem('oxenfurt_token', 'mock_token');
    window.sessionStorage.setItem('__telegram__initParams', JSON.stringify({ 
      tgWebAppVersion: '7.0', 
      tgWebAppPlatform: 'tdesktop', 
      tgWebAppData: 'user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Andrew%22%2C%22language_code%22%3A%22en%22%7D&hash=f' 
    }));
  });

  const page = await context.newPage();
  const url = `http://localhost:5173`;

  await page.route('**/*', async (route) => {
    const rUrl = route.request().url();
    if (rUrl.includes('/auth/dev-token')) return route.fulfill({ json: { token: 'mock_token' }, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (rUrl.includes('/health')) return route.fulfill({ json: { ok: true }, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (rUrl.includes('/stats/today')) return route.fulfill({ json: { reviewedToday: 42, dueCount: 154, streak: 12, learnedCount: 1200 }, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (rUrl.includes('/sessions/stats')) return route.fulfill({ json: {
      reviews: { today: { count: 42, correct: 38 }, last_7d: { count: 210, correct: 180 }, last_30d: { count: 850, correct: 720 } },
      forecast: { due_now: 154, due_next_24h: 35, active_total: 1200 },
      heatmap: Array.from({ length: 90 }, (_, i) => ({ date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), count: 10 })),
      recent_sessions: [{ id: '1', finished_at: new Date().toISOString(), cards_reviewed: 20, cards_correct: 18 }],
      learned_count: 1200, streak: 12, generated_at: new Date().toISOString()
    }, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (rUrl.includes('/cards/sources')) return route.fulfill({ json: { sources: [{ source: 'Lesson 1', total: 10, vocab_count: 5, phrase_count: 5, theory_count: 0, latest: new Date().toISOString() }] }, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (rUrl.includes('/cards/due')) return route.fulfill({ json: [
      { id: 'mock_1', phrase: 'Pragmatic', payload: { term: 'Pragmatic', translation: 'Practical', context_sentence: 'A pragmatic approach.' }, type: 'vocab', fsrs: { stability: 5.4 } }
    ], headers: { 'Access-Control-Allow-Origin': '*' } });
    if (rUrl.includes('/cards')) return route.fulfill({ json: { 
      cards: [{ id: 'mock_1', phrase: 'Pragmatic', payload: { term: 'Pragmatic', translation: 'Practical', context_sentence: 'A pragmatic approach.' }, type: 'vocab', reps: 5, lapses: 0, status: 'active', due: new Date().toISOString() }], 
      total: 1 
    }, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (rUrl.includes('/questions/count')) return route.fulfill({ json: { unread: 0 }, headers: { 'Access-Control-Allow-Origin': '*' } });
    
    return route.continue();
  });

  try {
    console.log('📸 home');
    await page.goto(`${url}/#home`);
    await page.waitForSelector('h1:has-text("Good")');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'home.png') });

    console.log('📸 settings');
    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('h2');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'settings.png') });
    await page.goto(`${url}/#home`);

    console.log('📸 library');
    await page.goto(`${url}/#library`);
    await page.waitForSelector('h1:has-text("Library")');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'library.png') });

    console.log('📸 stats');
    await page.goto(`${url}/#stats`);
    await page.waitForSelector('h1:has-text("Statistics")');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'stats.png') });

    console.log('📸 session');
    await page.goto(`${url}/#practice`);
    // wait for actual card term
    await page.waitForSelector('[data-testid="card-term"]', { timeout: 15000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'session.png') });

    console.log('✅ Done');
  } catch (err) {
    console.error('❌ Failed:', err.message);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'failure.png') });
  } finally {
    await browser.close();
    devServer.kill();
    process.exit(0);
  }
}

capture();
