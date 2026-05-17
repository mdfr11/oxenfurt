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
  
  const setupMocks = async (page) => {
    const api = `**/api`; // Match all API calls
    
    await page.route(`${api}/auth/dev-token`, r => r.fulfill({ json: { token: 'mock_token' }, headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.route(`${api}/health`, r => r.fulfill({ json: { ok: true }, headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.route(`${api}/stats/today`, r => r.fulfill({ json: { reviewedToday: 42, dueCount: 154, streak: 12, learnedCount: 1200 }, headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.route(`${api}/questions/count`, r => r.fulfill({ json: { unread: 0 }, headers: { 'Access-Control-Allow-Origin': '*' } }));
    
    await page.route(`${api}/sessions/stats`, r => r.fulfill({ json: {
      reviews: { today: { count: 42, correct: 38 }, last_7d: { count: 210, correct: 180 }, last_30d: { count: 850, correct: 720 } },
      forecast: { due_now: 154, due_next_24h: 35, active_total: 1200 },
      heatmap: Array.from({ length: 90 }, (_, i) => ({ date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), count: 10 })),
      recent_sessions: [{ id: '1', finished_at: new Date().toISOString(), cards_reviewed: 20, cards_correct: 18 }],
      learned_count: 1200, streak: 12, generated_at: new Date().toISOString()
    }, headers: { 'Access-Control-Allow-Origin': '*' } }));

    await page.route(`${api}/cards/sources*`, r => r.fulfill({ json: { sources: [{ source: 'Ancient Archives', total: 10, vocab_count: 5, phrase_count: 5, theory_count: 0, latest: new Date().toISOString() }] }, headers: { 'Access-Control-Allow-Origin': '*' } }));
    
    await page.route(`${api}/cards/due*`, r => r.fulfill({ json: [
      { id: 'm1', phrase: 'Pragmatic', payload: { term: 'Pragmatic', translation: 'Practical', context_sentence: 'A pragmatic approach to the problem.' }, type: 'vocab', fsrs: { stability: 5.4 } }
    ], headers: { 'Access-Control-Allow-Origin': '*' } }));

    await page.route(`${api}/cards*`, r => r.fulfill({ json: { 
      cards: [{ id: 'm1', phrase: 'Pragmatic', payload: { term: 'Pragmatic', translation: 'Practical', context_sentence: 'A pragmatic approach.' }, type: 'vocab', reps: 5, lapses: 0, status: 'active', due: new Date().toISOString() }], 
      total: 1 
    }, headers: { 'Access-Control-Allow-Origin': '*' } }));
  };

  const cleanOpen = async (hash = '') => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    
    await context.addInitScript(() => {
      window.localStorage.clear();
      window.localStorage.setItem('oxenfurt_settings', JSON.stringify({ nativeLanguage: 'en', learningLanguage: 'en', soundEnabled: true, hapticsEnabled: true, aiGradingEnabled: true }));
      window.localStorage.setItem('oxenfurt_token', 'mock_token');
      // Mock Telegram Env
      window.sessionStorage.setItem('__telegram__initParams', JSON.stringify({ 
        tgWebAppVersion: '7.0', 
        tgWebAppPlatform: 'tdesktop', 
        tgWebAppData: 'user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Andrew%22%2C%22language_code%22%3A%22en%22%7D&hash=f' 
      }));
      
      // KILL ALL ANIMATIONS for crisp screenshots
      const style = document.createElement('style');
      style.innerHTML = `
        *, *::before, *::after {
          transition-duration: 0s !important;
          animation-duration: 0s !important;
          transition-delay: 0s !important;
          animation-delay: 0s !important;
        }
      `;
      document.head.appendChild(style);
    });

    const page = await context.newPage();
    await setupMocks(page);
    await page.goto(`http://localhost:5173/#${hash}`);
    await page.waitForTimeout(2000); // Give React time to boot
    return { page, context };
  };

  try {
    console.log('📸 home');
    const { page: p1, context: c1 } = await cleanOpen('home');
    await p1.waitForSelector('h1:has-text("Good")');
    await p1.screenshot({ path: path.join(SCREENSHOTS_DIR, 'home.png') });
    await c1.close();

    console.log('📸 settings');
    const { page: p2, context: c2 } = await cleanOpen('home');
    await p2.click('button[aria-label="Settings"]');
    await p2.waitForSelector('h2:has-text("Settings")');
    await p2.screenshot({ path: path.join(SCREENSHOTS_DIR, 'settings.png') });
    await c2.close();

    console.log('📸 library');
    const { page: p3, context: c3 } = await cleanOpen('library');
    await p3.waitForSelector('h1:has-text("Library")');
    await p3.screenshot({ path: path.join(SCREENSHOTS_DIR, 'library.png') });
    await c3.close();

    console.log('📸 stats');
    const { page: p4, context: c4 } = await cleanOpen('stats');
    await p4.waitForSelector('h1:has-text("Statistics")');
    await p4.screenshot({ path: path.join(SCREENSHOTS_DIR, 'stats.png') });
    await c4.close();

    console.log('📸 session');
    const { page: p5, context: c5 } = await cleanOpen('practice');
    // Session screen takes longer to load due to FSRS logic
    await p5.waitForSelector('[data-testid="card-term"]', { timeout: 10000 });
    await p5.screenshot({ path: path.join(SCREENSHOTS_DIR, 'session.png') });
    await c5.close();

    console.log('✅ Done');
  } catch (err) {
    console.error('❌ Failed:', err.message);
  } finally {
    await browser.close();
    devServer.kill();
    process.exit(0);
  }
}

capture();
