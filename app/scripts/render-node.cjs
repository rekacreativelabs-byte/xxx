const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);

const FFMPEG_PATH = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
const SCALE = Math.max(1, Math.round(+opt('scale', '2'))); // default 4K (scale 2 = 3840x2160)
const OW = 1920 * SCALE, OH = 1080 * SCALE;

const SAMPLES = opt('samples', '1') === 'auto'
  ? { min: +opt('min-samples', '4'), max: +opt('max-samples', '108'), tol: +opt('tol', '3'), refine: opt('refine', 'tiles') }
  : +opt('samples', '1');

async function openPage(url) {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding'
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const only = opt('only');
  await page.goto(`${url}/?export=1${only ? `&only=${only}` : ''}${SCALE !== 1 ? `&scale=${SCALE}` : ''}`);
  await page.waitForFunction(() => window.__pdoom?.ready || window.__pdoom?.error, null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__pdoom.error);
  if (err) throw new Error(`app failed to boot:\n${err}`);
  return { browser, page };
}

async function renderVideo(url, from, to, fps, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const crf = opt('crf', '18');
  const audio = path.join(ROOT, 'audio/pdoom.mp3');

  console.log(`\n=== EXPORTING PDOOM VIDEO IN 4K (3840x2160 @ ${fps} FPS) ===`);
  console.log(`Resolution: ${OW}x${OH} (Scale ${SCALE})`);
  console.log(`Target: ${outPath}`);
  console.log(`Time: ${from}s -> ${to}s`);

  const ffmpegArgs = [
    '-y',
    '-loglevel', 'warning',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-s', `${OW}x${OH}`,
    '-r', String(fps),
    '-i', 'pipe:0'
  ];

  if (!flag('noaudio')) {
    ffmpegArgs.push('-ss', String(from), '-t', String(to - from), '-i', audio);
  }

  ffmpegArgs.push(
    '-vf', 'vflip,scale=out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709',
    '-c:v', 'libx264',
    '-preset', opt('preset', 'veryfast'),
    '-crf', crf,
    '-threads', '4',
    '-pix_fmt', 'yuv420p',
    '-tune', 'grain'
  );

  if (!flag('noaudio')) {
    ffmpegArgs.push('-c:a', 'aac', '-b:a', '320k', '-shortest');
  }

  ffmpegArgs.push('-movflags', '+faststart', outPath);

  const ff = spawn(FFMPEG_PATH, ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });

  const f0 = Math.round(from * fps), f1 = Math.round(to * fps), total = f1 - f0;
  const chunk = 8;
  const workers = 1; // single clean worker to prevent resource contention on Windows

  const frameBytes = OW * OH * 3;
  const waiting = new Map();
  const queue = Array.from({ length: workers }, () => []);
  const sockets = [];
  const ackCount = new Array(workers).fill(0);
  const ack = (k) => { ackCount[k]++; sockets[k]?.send(String(ackCount[k])); };
  let next = f0, written = 0, cursor = f0;

  let resolveWritten, rejectFailed;
  const allWritten = new Promise((res, rej) => { resolveWritten = res; rejectFailed = rej; });

  const drain = () => {
    while (waiting.has(next)) {
      const buf = waiting.get(next);
      waiting.delete(next);
      ff.stdin.write(buf);
      next++;
      written++;
      ack(0);
      if (written % 30 === 0 || written === total) {
        process.stdout.write(`\r[4K RENDER] ${written}/${total} frames (${((written / total) * 100).toFixed(0)}%)   `);
      }
      if (written === total) resolveWritten();
    }
  };

  const wss = new WebSocketServer({ port: 0, maxPayload: 64 * 1024 * 1024 });
  const port = wss.address().port;

  wss.on('connection', (ws, req) => {
    sockets[0] = ws;
    ws.on('message', (msg) => {
      const n = queue[0].shift();
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      waiting.set(n, buf);
      drain();
    });
  });

  const take = () => {
    if (cursor >= f1) return null;
    const a = cursor;
    cursor = Math.min(f1, a + chunk);
    return [a, cursor];
  };

  const { browser, page } = await openPage(url);

  try {
    for (let r = take(); r; r = take()) {
      for (let n = r[0]; n < r[1]; n++) queue[0].push(n);
      await page.evaluate((o) => window.__pdoom.stream(o), {
        from: r[0] / fps,
        to: r[1] / fps,
        fps,
        ws: `ws://localhost:${port}/?w=0`,
        samples: SAMPLES,
        shutter: 0.2,
        inflight: 4,
      });
    }

    await allWritten;
    console.log('\nAll 4K frames processed. Finalizing MP4...');
    ff.stdin.end();

    await new Promise((resolve, reject) => {
      ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
    });

    console.log(`\n=== 4K VIDEO SUCCESS ===`);
    console.log(`Location: ${outPath}`);
  } finally {
    await browser.close();
    wss.close();
  }
}

async function main() {
  const url = opt('url', 'http://localhost:5173');
  const { browser, page } = await openPage(url);
  const dur = await page.evaluate(() => window.__pdoom.duration);
  await browser.close();

  const out = opt('out', 'C:\\Users\\user\\Desktop\\Reka 1\\PODCAST\\Reka_PDoom_4K.mp4');
  const from = +opt('from', '0');
  const to = +opt('to', String(dur));
  const fps = +opt('fps', '60');

  await renderVideo(url, from, to, fps, out);
}

main().catch((err) => {
  console.error('\nRender Error:', err);
  process.exit(1);
});
