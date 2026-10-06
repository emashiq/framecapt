/**
 * A/V sync beacon for the recording benchmark (not part of the app). A standalone Electron process
 * that shows a small always-on-top window and plays sound:
 *   - a quiet continuous 440 Hz tone (so the recording carries steady system audio), and
 *   - every 10 s a 150 ms, 1 kHz beep, while the window flashes WHITE (otherwise black).
 * Both come from ONE timestamp source: the page watches the audio context's output clock
 * (`getOutputTimestamp().contextTime`, the sample time that is leaving the speakers) and paints
 * white exactly while that time lies inside a scheduled beep, so the flash and the beep share
 * their clock. The benchmark later measures flash-onset minus beep-onset in the RECORDED file at
 * the start and at the end: the change is the A/V drift.
 *
 * Usage: electron sync-beacon.mjs <x> <y> <size>
 * stdout: `READY {"bounds":{...},"scaleFactor":n,"display":{...}}` once the first beep is scheduled.
 */
import { app, BrowserWindow, powerSaveBlocker, screen } from 'electron';

const [x = '40', y = '40', size = '200', motion = 'static'] = process.argv.slice(2);

const MOTION_PAGE = `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#101830;overflow:hidden"><canvas id="c" width="640" height="360"></canvas>
<script>
  // Ordinary screen-like motion: a drifting gradient, bouncing shapes and scrolling text lines.
  const c = document.getElementById('c'), g = c.getContext('2d');
  const dots = Array.from({ length: 24 }, (_, i) => ({ x: (i * 97) % 640, y: (i * 53) % 360, vx: 40 + (i % 5) * 25, vy: 30 + (i % 7) * 20, r: 10 + (i % 4) * 6 }));
  let last = performance.now();
  function frame(now) {
    const dt = (now - last) / 1000; last = now;
    const t = now / 1000;
    const grad = g.createLinearGradient(0, 0, 640 * (0.5 + 0.5 * Math.sin(t / 3)), 360);
    grad.addColorStop(0, '#1d4ed8'); grad.addColorStop(1, '#9333ea');
    g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.font = '16px monospace';
    for (let i = 0; i < 14; i += 1) {
      const y = ((i * 28 - t * 90) % 392 + 392) % 392 - 16;
      g.fillText('FrameCapt benchmark line ' + (i + Math.floor(t * 3.2)) + ' - scrolling text', 16, y);
    }
    for (const d of dots) {
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.x < 0 || d.x > 640) d.vx = -d.vx;
      if (d.y < 0 || d.y > 360) d.vy = -d.vy;
      g.fillStyle = 'hsl(' + ((d.r * 13 + t * 40) % 360) + ',80%,60%)';
      g.beginPath(); g.arc(d.x, d.y, d.r, 0, 6.2832); g.fill();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
</script>`;

const PAGE = `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#000;overflow:hidden">
<script>
  // Every 10.0111 s: a hair over 10 s, so successive beeps fall on different phases of the 30 fps
  // frame grid (1/3 of a frame apart) and the quantisation of the picture averages out.
  const FIRST = 3, EVERY = 10.0111, LENGTH = 0.15;
  const ctx = new AudioContext();
  const master = ctx.createGain(); master.connect(ctx.destination);
  const tone = ctx.createOscillator(); tone.frequency.value = 440;
  const toneGain = ctx.createGain(); toneGain.gain.value = 0.04;
  tone.connect(toneGain).connect(master); tone.start();

  // Beeps are scheduled ahead on the audio clock, a few at a time.
  const base = ctx.currentTime;
  let scheduled = 0;
  const startOf = (n) => base + FIRST + n * EVERY;
  function schedule() {
    while (startOf(scheduled) < ctx.currentTime + 30) {
      const t = startOf(scheduled);
      const osc = ctx.createOscillator(); osc.frequency.value = 1000;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.005);
      gain.gain.setValueAtTime(0.25, t + LENGTH - 0.005);
      gain.gain.linearRampToValueAtTime(0, t + LENGTH);
      osc.connect(gain).connect(master);
      osc.start(t); osc.stop(t + LENGTH + 0.01);
      scheduled += 1;
    }
  }
  schedule(); setInterval(schedule, 5000);

  // The flash follows the audio output clock: white while a beep is leaving the speakers.
  function frame() {
    const now = ctx.getOutputTimestamp().contextTime;
    const into = (now - base - FIRST) % EVERY;
    const white = now - base - FIRST >= 0 && into >= 0 && into < LENGTH;
    document.body.style.background = white ? '#fff' : '#000';
    requestAnimationFrame(frame);
  }
  ctx.resume().then(() => { requestAnimationFrame(frame); document.title = 'ready'; });
</script>`;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(() => {
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    title: 'FrameCapt bench beacon',
    x: display.bounds.x + Number(x),
    y: display.bounds.y + Number(y),
    width: Number(size),
    height: Number(size),
    useContentSize: true,
    frame: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: true,
    backgroundColor: '#000000',
    webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Keeps the display and the system awake for the length of the benchmark.
  powerSaveBlocker.start('prevent-display-sleep');
  win.webContents.on('page-title-updated', (_event, title) => {
    if (title !== 'ready') return;
    setTimeout(() => {
      console.log(
        `READY ${JSON.stringify({
          bounds: win.getBounds(),
          contentBounds: win.getContentBounds(),
          scaleFactor: display.scaleFactor,
          display: { id: String(display.id), bounds: display.bounds, size: display.size },
        })}`,
      );
    }, 500);
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  if (motion === 'motion') {
    // A second window with ordinary on-screen motion, so the encoder has real work to do.
    const panel = new BrowserWindow({
      title: 'FrameCapt bench motion',
      x: display.bounds.x + Number(x) + Number(size) + 20,
      y: display.bounds.y + Number(y),
      width: 640,
      height: 360,
      useContentSize: true,
      frame: false,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: true,
      webPreferences: { backgroundThrottling: false },
    });
    panel.setAlwaysOnTop(true, 'screen-saver');
    void panel.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(MOTION_PAGE)}`);
  }
});

app.on('window-all-closed', () => app.quit());
