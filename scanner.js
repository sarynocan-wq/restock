// Barcode scanner: full-screen camera view that resolves with the scanned code (or null).
// Uses Chrome's built-in BarcodeDetector when available, otherwise the bundled ZXing library.

const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];

// Store every code in one shape so the same product always matches:
// digits only, and 12-digit UPC-A padded to 13 digits (EAN-13).
export function normalize(code) {
  let d = String(code || '').replace(/\D/g, '');
  if (d.length === 12) d = '0' + d;
  return d;
}

// Check digit test for EAN-8 / UPC-A / EAN-13 – rejects misreads.
function checksumOk(code) {
  const d = normalize(code);
  if (![8, 13].includes(d.length)) return true;      // other formats: nothing to check
  const digits = d.split('').map(Number), check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

function loadZxing() {
  if (window.ZXing) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/zxing.min.js'; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

let engine = null;
async function getEngine() {
  if (engine) return engine;
  if ('BarcodeDetector' in window) {
    try {
      const sup = await BarcodeDetector.getSupportedFormats();
      const formats = NATIVE_FORMATS.filter(f => sup.includes(f));
      if (formats.length) return (engine = { kind: 'native', det: new BarcodeDetector({ formats }) });
    } catch {}
  }
  await loadZxing();
  const Z = window.ZXing;
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.CODE_128]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader(); reader.setHints(hints);
  return (engine = { kind: 'zxing', reader, Z, canvas: document.createElement('canvas') });
}

function decodeZxing(e, video) {
  const { Z, reader, canvas } = e;
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return null;
  const k = Math.min(1, 960 / vw);
  canvas.width = Math.round(vw * k); canvas.height = Math.round(vh * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
  try {
    const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(lum, width, height)));
    return reader.decodeWithState(bmp).getText();
  } catch { return null; }
  finally { reader.reset(); }
}

export function scan({ title = 'Scan a barcode', hint = 'Hold the barcode inside the box' } = {}) {
  return new Promise(async resolve => {
    const ov = document.createElement('div');
    ov.className = 'scanner';
    ov.innerHTML = `
      <video playsinline muted></video>
      <div class="scan-top"><b>${title}</b><small>${hint}</small></div>
      <div class="scan-box"><div class="scan-line"></div></div>
      <div class="scan-status"></div>
      <form class="scan-manual hide"><input type="text" inputmode="numeric" placeholder="Type the barcode number" pattern="[0-9 ]{6,20}"><button class="btn" type="submit">Use this number</button></form>
      <div class="scan-actions">
        <button type="button" data-s="torch" class="hide">🔦 Light</button>
        <button type="button" data-s="type">⌨️ Type it</button>
        <button type="button" data-s="cancel">Cancel</button>
      </div>`;
    document.body.appendChild(ov);
    const video = ov.querySelector('video'), status = ov.querySelector('.scan-status');
    const manual = ov.querySelector('.scan-manual');
    let stream = null, running = true, timer = null, torchOn = false;

    const done = code => {
      if (!running) return;
      running = false; clearTimeout(timer);
      if (stream) stream.getTracks().forEach(t => t.stop());
      ov.remove();
      resolve(code ? normalize(code) : null);
    };
    const showManual = () => { manual.classList.remove('hide'); manual.querySelector('input').focus(); };
    ov.querySelector('[data-s="cancel"]').onclick = () => done(null);
    ov.querySelector('[data-s="type"]').onclick = showManual;
    manual.onsubmit = ev => {
      ev.preventDefault();
      const v = normalize(manual.querySelector('input').value);
      if (v.length < 6) { status.textContent = 'That number looks too short.'; return; }
      done(v);
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      status.textContent = 'Camera not available. Allow camera access, or type the number.';
      showManual(); return;
    }
    if (!running) { stream.getTracks().forEach(t => t.stop()); return; }
    video.srcObject = stream;
    try { await video.play(); } catch {}

    const track = stream.getVideoTracks()[0];
    try {
      if (track.getCapabilities && track.getCapabilities().torch) {
        const b = ov.querySelector('[data-s="torch"]'); b.classList.remove('hide');
        b.onclick = async () => { torchOn = !torchOn; try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch {} };
      }
    } catch {}

    let eng;
    try { eng = await getEngine(); } catch { status.textContent = 'Scanner could not load. Type the number instead.'; showManual(); return; }

    const tick = async () => {
      if (!running) return;
      let code = null;
      try {
        if (eng.kind === 'native') { const r = await eng.det.detect(video); if (r.length) code = r[0].rawValue; }
        else code = decodeZxing(eng, video);
      } catch {}
      if (code && checksumOk(code)) { try { navigator.vibrate && navigator.vibrate(80); } catch {} done(code); return; }
      timer = setTimeout(tick, eng.kind === 'native' ? 120 : 180);
    };
    tick();
  });
}
