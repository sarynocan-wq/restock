// Data layer for Restock.
// Two backends behind one interface:
//   cloud – Supabase (shared between phones, live sync, photo storage)
//   demo  – this device's localStorage only (used when config.js is empty)
// Writes go through an "outbox" so changes made with no signal are sent later.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

let sb = null;
export let mode = 'demo';
export let onError = () => {};
export let onOutboxChange = () => {};
export function setHandlers(h) { if (h.onError) onError = h.onError; if (h.onOutboxChange) onOutboxChange = h.onOutboxChange; }

const readJSON = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export async function init() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    mode = 'cloud';
  }
  return mode;
}

/* ---------------- auth ---------------- */
export async function currentUser() {
  if (!sb) return { id: 'demo', email: 'demo mode' };
  const { data } = await sb.auth.getSession();
  return data.session?.user || null;
}
export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}
export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) throw error;
  return data; // data.session is null when email confirmation is required
}
export async function signOut() {
  if (sb) await sb.auth.signOut();
  outbox = []; persist();
}

/* ---------------- household ---------------- */
export async function myHousehold() {
  if (!sb) return { id: 'demo', name: 'Demo home', invite_code: '—' };
  const { data, error } = await sb.from('households').select('id,name,invite_code').limit(1);
  if (error) throw error;
  return data[0] || null;
}
export async function createHousehold(name, myName) {
  const { data, error } = await sb.rpc('create_household', { hh_name: name, my_name: myName });
  if (error) throw error;
  return data;
}
export async function joinHousehold(code, myName) {
  const { data, error } = await sb.rpc('join_household', { code, my_name: myName });
  if (error) throw error;
  return data;
}

/* ---------------- columns ---------------- */
const COLS = {
  rooms: ['id', 'household_id', 'name', 'sort', 'spots'],
  stores: ['id', 'household_id', 'chain', 'location', 'sort', 'aisles'],
  products: ['id', 'household_id', 'name', 'brand', 'brand_only', 'size', 'emoji', 'photo_path', 'barcode', 'spot_id',
    'status', 'skip', 'extra', 'got', 'count_mode', 'qty', 'min_qty', 'target', 'only_at', 'aisles'],
};
function clean(table, row) {
  const out = {};
  for (const c of COLS[table]) if (row[c] !== undefined) out[c] = row[c];
  if (table === 'products') out.updated_at = new Date().toISOString();
  return out;
}

/* ---------------- load ---------------- */
export async function loadAll(hh) {
  if (!sb) return demoLoad();
  const out = {};
  await Promise.all(Object.keys(COLS).map(async t => {
    const { data, error } = await sb.from(t).select('*').eq('household_id', hh);
    if (error) throw error;
    out[t] = data;
  }));
  return applyPending(out);
}

/* ---------------- outbox (offline-safe writes) ---------------- */
const OB = 'restock-outbox';
let outbox = readJSON(OB, []);
const keyOf = o => o.table + ':' + (o.row ? o.row.id : o.id);
function persist() { writeJSON(OB, outbox); onOutboxChange(outbox.length); }
export const pendingCount = () => outbox.length;
export function pendingIds() { return new Set(outbox.map(o => o.row ? o.row.id : o.id)); }

// Re-apply edits that haven't reached the server yet on top of freshly loaded data.
export function applyPending(data) {
  for (const o of outbox) {
    const list = data[o.table]; if (!list) continue;
    const id = o.row ? o.row.id : o.id;
    const i = list.findIndex(r => r.id === id);
    if (o.op === 'delete') { if (i >= 0) list.splice(i, 1); }
    else if (i >= 0) list[i] = { ...list[i], ...o.row }; else list.push({ ...o.row });
  }
  return data;
}

export function save(table, row) {
  if (!sb) return demoSave(table, row);
  const o = { table, op: 'upsert', row: clean(table, row) };
  outbox = outbox.filter(x => keyOf(x) !== keyOf(o));
  outbox.push(o); persist(); flush();
}
export function remove(table, id) {
  if (!sb) return demoRemove(table, id);
  const o = { table, op: 'delete', id };
  outbox = outbox.filter(x => keyOf(x) !== keyOf(o));
  outbox.push(o); persist(); flush();
}

const isNetwork = e => !e?.code && /fetch|network|load failed/i.test(e?.message || String(e));
let flushing = false;
export async function flush() {
  if (!sb || flushing || !outbox.length) return;
  flushing = true;
  try {
    while (outbox.length) {
      const o = outbox[0];
      const res = o.op === 'upsert'
        ? await sb.from(o.table).upsert(o.row)
        : await sb.from(o.table).delete().eq('id', o.id);
      if (res.error) {
        if (isNetwork(res.error)) break;      // offline: keep it and try later
        onError(res.error);                    // real error: report and drop it
      }
      outbox.shift(); persist();
    }
  } catch (e) { /* offline – retry later */ }
  finally { flushing = false; }
}
if (typeof window !== 'undefined') window.addEventListener('online', () => flush());

/* ---------------- live sync ---------------- */
export function subscribe(hh, cb) {
  if (!sb) return;
  const ch = sb.channel('restock-' + hh);
  for (const t of Object.keys(COLS)) ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, p => cb(t, p));
  ch.subscribe();
}

/* ---------------- photos ---------------- */
const urlCache = {};
export async function uploadPhoto(hh, productId, blob, dataUrl) {
  if (!sb) return dataUrl;                       // demo: keep the image inline
  const path = `${hh}/${productId}-${Date.now()}.jpg`;
  const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
  if (error) throw error;
  return path;
}
export async function deletePhoto(path) {
  if (sb && path && !path.startsWith('data:')) { try { await sb.storage.from('photos').remove([path]); } catch {} }
}
export async function loadPhotoUrls(paths) {
  const need = [...new Set(paths)].filter(p => p && !p.startsWith('data:') && !urlCache[p]);
  if (!sb || !need.length) return false;
  try {
    const { data } = await sb.storage.from('photos').createSignedUrls(need, 60 * 60 * 24 * 7);
    (data || []).forEach(d => { if (d.signedUrl) urlCache[d.path] = d.signedUrl; });
    return true;
  } catch { return false; }
}
export const photoUrl = p => !p ? null : p.startsWith('data:') ? p : urlCache[p] || null;

/* ---------------- demo backend ---------------- */
const DEMO = 'restock-demo';
let demoStarter = () => ({ rooms: [], stores: [], products: [] });
export function setDemoStarter(fn) { demoStarter = fn; }
function demoData() { let d = readJSON(DEMO, null); if (!d) { d = demoStarter(); writeJSON(DEMO, d); } return d; }
function demoLoad() { return JSON.parse(JSON.stringify(demoData())); }
function demoSave(table, row) {
  const d = demoData(); const list = d[table]; const i = list.findIndex(r => r.id === row.id);
  const c = JSON.parse(JSON.stringify(row)); if (i >= 0) list[i] = c; else list.push(c); writeJSON(DEMO, d);
}
function demoRemove(table, id) { const d = demoData(); d[table] = d[table].filter(r => r.id !== id); writeJSON(DEMO, d); }
export function demoReset() { try { localStorage.removeItem(DEMO); } catch {} }
