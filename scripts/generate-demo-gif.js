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
    localStorage.setItem('oxenfurt_settings', JSON.stringify({ nativeLanguage: 'en', learningLanguage: 'en', soundEnabled: true, hapticsEnabled: true }));
    localStorage.setItem('oxenfurt_token', 'mock_token');
    window.sessionStorage.setItem('__telegram__initParams', JSON.stringify({ tgWebAppVersion: '7.0', tgWebAppPlatform: 'tdesktop', tgWebAppData: 'user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Andrew%22%2C%22language_code%22%3A%22en%22%7D&hash=f' }));
  });

  const setupMocks = async (page) => {
    await page.route('http://localhost:3000/**', r => {
      const url = r.request().url();
      console.log(`    [MOCK] ${url}`);
      
      let body = {};
      if (url.includes('/auth/dev-token')) body = { token: 'mock_token' };
      else if (url.includes('/health')) body = { ok: true };
      else if (url.includes('/stats/today')) body = { reviewedToday: 42, dueCount: 154, streak: 12, learnedCount: 1200 };
      else if (url.includes('/stats/heatmap')) body = { history: [] };
      else if (url.includes('/sessions')) body = { id: 'mock_session_id' };
      else if (url.includes('/questions/count')) body = { unread: 0 };
      else if (url.includes('/cards/due')) body = [
        { 
          id: '1', 
          type: 'vocab', 
          payload: { term: 'Resilient', translation: 'Устойчивый', context_sentence: 'A resilient system withstands shocks.', context_term_start: 2, context_term_end: 11 }, 
          source: 'demo', 
          source_quote: null,
          fsrs: { fsrs_state: 2, due: new Date().toISOString(), stability: 5, difficulty: 3, elapsed_days: 1, scheduled_days: 5, learning_steps: 0, reps: 5, lapses: 0, last_review: new Date().toISOString() } 
        },
        { 
          id: '2', 
          type: 'vocab', 
          payload: { term: 'Nuance', translation: 'Нюанс', context_sentence: 'Pay attention to the nuance.', context_term_start: 19, context_term_end: 25 }, 
          source: 'demo', 
          source_quote: null,
          fsrs: { fsrs_state: 2, due: new Date().toISOString(), stability: 12, difficulty: 2, elapsed_days: 3, scheduled_days: 12, learning_steps: 0, reps: 3, lapses: 0, last_review: new Date().toISOString() } 
        },
        { 
          id: '3', 
          type: 'vocab', 
          payload: { term: 'Pragmatic', translation: 'Прагматичный', context_sentence: 'A pragmatic choice.', context_term_start: 2, context_term_end: 11 }, 
          source: 'demo', 
          source_quote: null,
          fsrs: { fsrs_state: 1, due: new Date().toISOString(), stability: 2, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, last_review: null } 
        }
      ];
      
      return r.fulfill({ json: body, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
  };

  const page = await context.newPage();
  page.on('console', msg => console.log('  [PAGE]', msg.text()));
  await setupMocks(page);

  try {
    console.log('  - Navigating to Practice');
    await page.goto('http://localhost:5173/#practice');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'debug_practice.png') });
    
    console.log('  - Waiting for card');
    // Wait for card wrapper or any text
    await page.waitForSelector('.perspective-1000, h2, h3', { timeout: 15000 });
    await page.waitForTimeout(2000);

    // 2. Swipe First Card Right (Easy)
    console.log('  - Swiping card 1 (Right)');
    const card = page.locator('.perspective-1000').first();
    let box = await card.boundingBox();
    if (!box) throw new Error('Card not found for swipe');
    
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 300, box.y + box.height / 2, { steps: 40 });
    await page.mouse.up();
    await page.waitForTimeout(2000);

    // 3. Swipe Second Card Left (Again)
    console.log('  - Swiping card 2 (Left)');
    await page.waitForSelector('[data-testid="card-term"]');
    box = await card.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 300, box.y + box.height / 2, { steps: 40 });
    await page.mouse.up();
    await page.waitForTimeout(2000);

    // 4. Reveal Third Card
    console.log('  - Revealing card 3');
    await page.waitForSelector('[data-testid="card-term"]');
    await page.click('.perspective-1000');
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Good"), button:has-text("Хорошо")');
    await page.waitForTimeout(3000);

    await context.close();
    const files = fs.readdirSync(VIDEO_DIR);
    if (files.length === 0) throw new Error('No video recorded');
    const videoPath = path.join(VIDEO_DIR, files[0]);
    const gifPath = path.join(SCREENSHOTS_DIR, 'demo.gif');

    console.log('🎞 Converting to GIF...');
    execSync(`ffmpeg -y -i ${videoPath} -vf "fps=15,scale=320:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" ${gifPath}`);
    
    console.log(`✅ Demo GIF created at ${gifPath}`);
  } catch (err) {
    console.error('❌ Failed:', err.message);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'recording_failure.png') });
  } finally {
    await browser.close();
    devServer.kill();
    fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
    process.exit(0);
  }
}

record();
