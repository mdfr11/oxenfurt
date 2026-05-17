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

  const browser = await chromium.launch();
  
  const setupMocks = async (page) => {
    const api = `http://localhost:3000`;
    const mock = (p, j) => page.route(p, r => r.fulfill({ json: j, headers: { 'Access-Control-Allow-Origin': '*' } }));

    await mock(`**/auth/dev-token`, { token: 'mock_token' });
    await mock(`**/health`, { ok: true });
    await mock(`**/stats/today`, { reviewedToday: 42, dueCount: 154, streak: 12, learnedCount: 1200 });
    await mock(`**/questions/count`, { unread: 0 });
    
    // Stats component mock - FILL IT UP
    await mock(`**/sessions/stats`, {
      reviews: {
        today: { count: 42, correct: 38 },
        last_7d: { count: 210, correct: 180 },
        last_30d: { count: 850, correct: 720 }
      },
      forecast: { due_now: 154, due_next_24h: 35, active_total: 1200 },
      heatmap: Array.from({ length: 90 }, (_, i) => ({
        date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
        count: Math.floor(Math.random() * 20) + 5
      })),
      recent_sessions: Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        finished_at: new Date(Date.now() - i * 3600000).toISOString(),
        cards_reviewed: 20 + i,
        cards_correct: 18 + i
      })),
      learned_count: 1200,
      streak: 12,
      generated_at: new Date().toISOString()
    });

    await mock(`**/cards/sources*`, { sources: [{ source: 'Lesson: Ancient Runes', total: 10, vocab_count: 5, phrase_count: 3, theory_count: 2, latest: new Date().toISOString() }] });
    
    await mock(`**/cards?*`, { 
      cards: Array.from({ length: 8 }, (_, i) => ({
        id: String(i),
        phrase: `Term ${i}`,
        payload: { term: `Term ${i}`, translation: `Translation ${i}`, context_sentence: `Context for term ${i}` },
        type: 'vocab', reps: 5, lapses: 0, status: 'active', due: new Date().toISOString()
      })), 
      total: 8 
    });

    await mock(`**/cards/due*`, [
      { id: 'm1', phrase: 'Pragmatic', payload: { term: 'Pragmatic', translation: 'Practical', context_sentence: 'A pragmatic approach to the problem.' }, type: 'vocab', fsrs: { stability: 5.4 } }
    ]);
  };

  const cleanOpen = async (hash = '') => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      localStorage.setItem('oxenfurt_settings', JSON.stringify({ nativeLanguage: 'en', learningLanguage: 'en', soundEnabled: true, hapticsEnabled: true, aiGradingEnabled: true }));
      localStorage.setItem('oxenfurt_token', 'mock_token');
      window.sessionStorage.setItem('__telegram__initParams', JSON.stringify({ tgWebAppVersion: '7.0', tgWebAppPlatform: 'tdesktop', tgWebAppData: 'user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Andrew%22%2C%22language_code%22%3A%22en%22%7D&hash=f' }));
      const s = document.createElement('style'); s.innerHTML = '*, *::before, *::after { transition: none !important; animation: none !important; }'; document.head.appendChild(s);
    });
    const page = await context.newPage();
    await setupMocks(page);
    await page.goto(`http://localhost:5173/#${hash}`);
    await page.waitForTimeout(6000);
    return { page, context };
  };

  try {
    const screens = { 'home': 'home', 'settings': 'settings', 'library': 'library', 'stats': 'stats', 'session': 'practice' };
    for (const [file, hash] of Object.entries(screens)) {
      console.log(`📸 ${file}`);
      const { page, context } = await cleanOpen(hash);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${file}.png`) });
      await context.close();
    }
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
