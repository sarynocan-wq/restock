// Product lookup by barcode in the free Open Food Facts family of databases.
// Food first, then beauty/personal care, then other household products.
// Coverage of Canadian and store-brand products is patchy; a miss just means "fill it in yourself".

const SOURCES = [
  'https://world.openfoodfacts.org',
  'https://world.openbeautyfacts.org',
  'https://world.openproductsfacts.org',
];
const FIELDS = 'product_name,product_name_en,brands,quantity,image_front_url,image_front_small_url';

async function getJSON(url, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

export async function lookup(code) {
  for (const base of SOURCES) {
    const j = await getJSON(`${base}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`);
    const p = j && j.status === 1 && j.product;
    if (!p) continue;
    const name = (p.product_name_en || p.product_name || '').trim();
    const brand = (p.brands || '').split(',')[0].trim();
    if (!name && !brand) continue;
    return { name, brand, size: (p.quantity || '').trim(), image: p.image_front_url || p.image_front_small_url || null };
  }
  return null;
}

export async function fetchImage(url) {
  try { const r = await fetch(url); return r.ok ? await r.blob() : null; } catch { return null; }
}
