import { chromium } from 'playwright';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const SCREENSHOTS_DIR = path.resolve('docs/screenshots');
const VIDEO_DIR = path.resolve('docs/temp_video');

async function record() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });

  console.log('🚀 Starting Vite...');
  const devServer = spawn('pnpm', ['dev'], { cwd: path.resolve('apps/mini-app'), shell: true });
  await new Promise(r => devServer.stdout.on('data', d => d.toString().includes('Local:') && r()));

  console.log('🎥 Recording Demo...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    recordVideo: { dir: VIDEO_DIR, size: { width: 390, height: 844 } }
  });

  await context.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('oxenfurt_settings', JSON.stringify({ nativeLanguage: 'en', learningLanguage: 'en', soundEnabled: true, hapticsEnabled: true, aiGradingEnabled: true }));
    localStorage.setItem('oxenfurt_token', 'mock_token');
    window.sessionStorage.setItem('__telegram__initParams', JSON.stringify({ 
        tgWebAppVersion: '7.0', 
        tgWebAppPlatform: 'tdesktop', 
        tgWebAppData: 'user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Andrew%22%2C%22language_code%22%3A%22en%22%7D&hash=f' 
    }));
  });

  const page = await context.newPage();
  
  const setupMocks = async (page) => {
    await page.route('**/api/**', r => {
      const url = r.request().url();
      let body = {};
      if (url.includes('/auth/dev-token')) body = { token: 'mock_token' };
      else if (url.includes('/health')) body = { ok: true };
      else if (url.includes('/stats/today')) body = { reviewedToday: 42, dueCount: 154, streak: 12, learnedCount: 1200 };
      else if (url.includes('/stats/heatmap')) body = { history: [] };
      else if (url.includes('/sessions/stats')) body = {
        reviews: { today: { count: 42, correct: 38 }, last_7d: { count: 210, correct: 180 }, last_30d: { count: 850, correct: 720 } },
        forecast: { due_now: 154, due_next_24h: 35, active_total: 1200 },
        heatmap: Array.from({ length: 90 }, (_, i) => ({ date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), count: 10 })),
        recent_sessions: [{ id: '1', finished_at: new Date().toISOString(), cards_reviewed: 20, cards_correct: 18 }],
        learned_count: 1200, streak: 12, generated_at: new Date().toISOString()
      };
      else if (url.includes('/sessions')) body = { id: 'mock_session' };
      else if (url.includes('/cards/due')) body = {
        cards: [
          { id: '1', type: 'vocab', payload: { term: 'Pragmatic', translation: 'Practical', context_sentence: 'A pragmatic approach.' }, fsrs: { fsrs_state: 2, due: new Date().toISOString(), stability: 5, difficulty: 3, elapsed_days: 1, scheduled_days: 5, learning_steps: 0, reps: 5, lapses: 0, last_review: new Date().toISOString() } },
          { id: '2', type: 'theory', payload: { question: 'What is SRS?', answer: 'Spaced Repetition System.' }, fsrs: { fsrs_state: 2, due: new Date().toISOString(), stability: 3, difficulty: 2, elapsed_days: 1, scheduled_days: 3, learning_steps: 0, reps: 2, lapses: 0, last_review: new Date().toISOString() } }
        ]
      };
      return r.fulfill({ json: body, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
  };

  await setupMocks(page);

  try {
    console.log('  - home');
    await page.goto('http://localhost:5173/#home');
    await page.waitForTimeout(3000);

    console.log('  - practice');
    await page.goto('http://localhost:5173/#practice');
    await page.waitForTimeout(4000);

    console.log('  - swipe right');
    const card = page.locator('div.bg-app-surface').first();
    let box = await card.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1000);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 300, box.y + box.height / 2, { steps: 40 });
    await page.mouse.up();
    await page.waitForTimeout(2000);

    console.log('  - stats');
    await page.goto('http://localhost:5173/#stats');
    await page.waitForTimeout(4000);

    await context.close();
    const videoPath = path.join(VIDEO_DIR, fs.readdirSync(VIDEO_DIR)[0]);
    const gifPath = path.join(SCREENSHOTS_DIR, 'demo.gif');
    execSync(`ffmpeg -y -i ${videoPath} -vf "fps=10,scale=320:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" ${gifPath}`);
    console.log(`✅ ${gifPath}`);
  } catch (err) {
    console.error('❌ Failed:', err.message);
  } finally {
    await browser.close();
    devServer.kill();
    process.exit(0);
  }
}

record();
