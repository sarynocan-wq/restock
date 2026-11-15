// Restock – shared grocery list & home inventory
import * as db from './db.js';

/* ======================= basics ======================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const sid = () => Math.random().toString(36).slice(2, 10);   // short ids for spots/aisles inside JSON
const clone = o => JSON.parse(JSON.stringify(o));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200); }

let S = { rooms: [], stores: [], products: [] };
let HH = null, USER = null;
const ui = { tab: 'home', storeId: lsGet('restock-store', null), closed: {}, q: '', armed: null };
let draft = null;          // working copy inside an editor sheet
let draftPhoto = null;     // { blob, dataUrl } picked but not yet uploaded

/* ======================= starter data ======================= */
const SECTIONS = ['Produce', 'Bakery', 'Meat', 'Dairy & Eggs', 'Frozen', 'Pantry', 'Breakfast & Coffee', 'Household', 'Personal Care'];
function starterRooms(hh) {
  const R = (name, sort, spots) => ({ id: uid(), household_id: hh, name, sort, spots: spots.map(n => ({ id: sid(), name: n })) });
  return [R('Kitchen', 0, ['Fridge', 'Freezer', 'Pantry', 'Counter']), R('Bathroom', 1, ['Cabinet']),
    R('Laundry', 2, ['Shelf']), R('Garage', 3, ['Shelf'])];
}
function starterStores(hh) {
  const St = (chain, sort, secs = SECTIONS) => ({ id: uid(), household_id: hh, chain, location: '', sort, aisles: secs.map(l => ({ id: sid(), num: '', label: l })) });
  return [St('Walmart', 0), St("Longo's", 1), St('Farm Boy', 2), St('Costco', 3),
    St('Canadian Tire', 4, ['Automotive', 'Cleaning & Paper', 'Household'])];
}
function demoStarter() {
  const rooms = starterRooms('demo'), stores = starterStores('demo');
  const spot = (r, s) => rooms.find(x => x.name === r).spots.find(x => x.name === s).id;
  const P = (name, brand, brand_only, size, emoji, r, s, status, sec, extra = {}) => {
    const aisles = {};
    for (const st of stores) { const a = st.aisles.find(a => a.label === sec); if (a) aisles[st.id] = a.id; }
    return { id: uid(), household_id: 'demo', name, brand, brand_only, size, emoji, photo_path: null, barcode: null, spot_id: spot(r, s),
      status, skip: false, extra: false, got: false, count_mode: false, qty: 0, min_qty: 1, target: 2, only_at: [], aisles, ...extra };
  };
  const products = [
    P('2% Milk', 'Lactantia', false, '2 L', '🥛', 'Kitchen', 'Fridge', 'low', 'Dairy & Eggs'),
    P('Eggs', '', false, 'Dozen, large', '🥚', 'Kitchen', 'Fridge', 'out', 'Dairy & Eggs'),
    P('Coffee', 'Kicking Horse', true, 'Whole bean, 454 g', '☕', 'Kitchen', 'Pantry', 'low', 'Breakfast & Coffee'),
    P('Canned Tomatoes', '', false, 'Diced, 796 mL', '🥫', 'Kitchen', 'Pantry', 'have', 'Pantry', { count_mode: true, qty: 2, min_qty: 2, target: 6 }),
    P('Bananas', '', false, 'Bunch', '🍌', 'Kitchen', 'Counter', 'out', 'Produce'),
    P('Toilet Paper', 'Kirkland', true, '30 rolls', '🧻', 'Bathroom', 'Cabinet', 'have', 'Household', { only_at: ['Costco'] }),
    P('Washer Fluid', '', false, '-40 °C', '🚗', 'Garage', 'Shelf', 'out', 'Automotive', { only_at: ['Canadian Tire'] }),
  ];
  return { rooms, stores, products };
}
db.setDemoStarter(demoStarter);

/* ======================= derived ======================= */
const statusOf = p => p.count_mode ? (p.qty <= 0 ? 'out' : p.qty <= p.min_qty ? 'low' : 'have') : p.status;
const onList = p => !p.skip && (statusOf(p) !== 'have' || p.extra);
const buyQty = p => Math.max(1, (p.target || 0) - (p.qty || 0));
const storeName = st => st.location ? `${st.chain} — ${st.location}` : st.chain;
const storeById = id => S.stores.find(s => s.id === id);
const prodById = id => S.products.find(p => p.id === id);
const chains = () => [...new Set(S.stores.map(s => s.chain))];
const spotInfo = id => { for (const r of S.rooms) for (const s of r.spots) if (s.id === id) return { room: r, spot: s }; return null; };
function thumb(p, big) {
  const src = (draft && draft.id === p.id && draftPhoto) ? draftPhoto.dataUrl : db.photoUrl(p.photo_path);
  return `<div class="thumb ${big ? 'big' : ''}">${src ? `<img src="${src}" alt="">` : esc(p.emoji || '🛒')}</div>`;
}
const sub = p => (p.brand ? (p.brand_only ? `<span class="strict">${esc(p.brand)} only</span>` : `${esc(p.brand)} or similar`) : 'Any brand') + (p.size ? ' · ' + esc(p.size) : '');
const tagFor = p => p.skip ? '<span class="tag skip">Not needed</span>'
  : statusOf(p) === 'have' ? '' : `<span class="tag ${statusOf(p)}">${statusOf(p) === 'low' ? 'Low' : 'Out'}</span>`;
function arm(key) {
  if (ui.armed === key) { ui.armed = null; return true; }
  ui.armed = key; toast('Tap again to confirm'); setTimeout(() => { if (ui.armed === key) ui.armed = null; }, 3000); return false;
}
function sortAll() {
  S.rooms.sort((a, b) => a.sort - b.sort);
  S.stores.sort((a, b) => a.chain.localeCompare(b.chain) || a.location.localeCompare(b.location));
}
const saveP = p => db.save('products', p);

/* ======================= cache (works with no signal) ======================= */
const cacheKey = () => 'restock-cache-' + (HH ? HH.id : '');
function saveCache() { if (HH) lsSet(cacheKey(), { HH, S }); }
function loadCache() { const c = lsGet(cacheKey(), null); if (c) { S = c.S; sortAll(); } }

/* ======================= render ======================= */
let renderQueued = false;
function queueRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
function render() {
  if (!HH) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  const n = S.products.filter(p => onList(p) && !p.got).length;
  const lc = $('#listCount'); lc.textContent = n || ''; lc.style.display = n ? '' : 'none';
  $('#sub').textContent = { home: 'Walk the house', list: 'Shopping list', products: 'All products', setup: 'Setup' }[ui.tab];
  const focusQ = document.activeElement && document.activeElement.id === 'q';
  const pos = focusQ ? document.activeElement.selectionStart : 0;
  $('#view').innerHTML = ({ home: viewHome, list: viewList, products: viewProducts, setup: viewSetup })[ui.tab]();
  if (focusQ && $('#q')) { $('#q').focus(); try { $('#q').setSelectionRange(pos, pos); } catch {} }
  saveCache();
}
function syncBadge(n) {
  const el = $('#sync'); if (!el) return;
  if (db.mode === 'demo') { el.textContent = 'Demo mode'; el.className = 'sync demo'; return; }
  el.textContent = n ? `${n} change${n > 1 ? 's' : ''} waiting` : (navigator.onLine ? 'Synced' : 'Offline');
  el.className = 'sync ' + (n || !navigator.onLine ? 'wait' : 'ok');
}

function viewHome() {
  if (!S.products.length) return `<div class="empty">No products yet.<br><br><button class="btn" data-act="newProduct">+ Add your first product</button></div>`;
  let h = `<p class="hint">Tap <b>Low</b> or <b>Out</b> as you walk the house. Those go on the shared list. <b>Skip</b> = out, but not needed right now.</p>`;
  const row = p => {
    const ctl = p.count_mode
      ? `<div class="step"><button data-qty="-1" data-id="${p.id}" aria-label="One less">−</button><span>${p.qty}</span><button data-qty="1" data-id="${p.id}" aria-label="One more">+</button></div>`
      : `<div class="seg">${['have', 'low', 'out', 'skip'].map(k => `<button class="${k} ${(k === 'skip' ? p.skip : (!p.skip && p.status === k)) ? 'on' : ''}" data-status="${k}" data-id="${p.id}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>`;
    return `<div class="row ${p.skip ? 'skipped' : ''}"><div data-edit="${p.id}">${thumb(p)}</div>
      <div class="info" data-edit="${p.id}"><b>${esc(p.name)}${p.count_mode ? tagFor(p) : ''}</b><small>${sub(p)}</small></div>${ctl}</div>`;
  };
  for (const r of S.rooms) {
    const items = S.products.filter(p => r.spots.some(s => s.id === p.spot_id));
    const need = items.filter(p => !p.skip && statusOf(p) !== 'have').length;
    const closed = ui.closed[r.id];
    h += `<button class="roomhead" data-room="${r.id}"><span>${esc(r.name)}${need ? `<span class="badge">${need}</span>` : ''}</span><span>${closed ? '▸' : '▾'}</span></button>`;
    if (closed) continue;
    for (const s of r.spots) {
      const its = items.filter(p => p.spot_id === s.id).sort((a, b) => a.name.localeCompare(b.name));
      if (its.length) h += `<h4>${esc(s.name)}</h4>` + its.map(row).join('');
    }
  }
  const lost = S.products.filter(p => !spotInfo(p.spot_id));
  if (lost.length) h += `<button class="roomhead"><span>Not placed yet</span></button>` + lost.map(row).join('');
  return h + `<button class="btn sec" data-act="newProduct">+ Add product</button>`;
}

function viewList() {
  if (!storeById(ui.storeId)) ui.storeId = S.stores[0]?.id || null;
  const st = storeById(ui.storeId);
  if (!st) return `<div class="empty">Add a store in Setup first.</div>`;
  const all = S.products.filter(onList);
  const here = all.filter(p => !p.only_at.length || p.only_at.includes(st.chain));
  const elsewhere = all.filter(p => !here.includes(p));
  const got = here.filter(p => p.got).length;
  let h = `<label class="f" style="margin-top:0">Shopping at</label>
    <select id="storeSel">${S.stores.map(s => `<option value="${s.id}" ${s.id === st.id ? 'selected' : ''}>${esc(storeName(s))}</option>`).join('')}</select>
    <div class="progress"><div style="width:${here.length ? got / here.length * 100 : 0}%"></div></div>
    <p class="hint">${got} of ${here.length} in the cart</p>`;
  if (!all.length) return h + `<div class="empty">🎉 Nothing on the list.<br>Mark items Low or Out on the Home tab.</div>` + listButtons();
  const row = (p, assign) => `<div class="row ${p.got ? 'got' : ''}">
      <button class="check ${p.got ? 'on' : ''}" data-got="${p.id}" aria-label="In cart">${p.got ? '✓' : ''}</button>
      <div data-edit="${p.id}">${thumb(p)}</div>
      <div class="info" data-edit="${p.id}"><b>${esc(p.name)}${p.count_mode ? `<span class="tag buy">Buy ${buyQty(p)}</span>` : ''}${statusOf(p) === 'have' ? '<span class="tag add">Added</span>' : tagFor(p)}</b><small>${sub(p)}</small></div>
    </div>${assign ? `<select data-assign="${p.id}" class="assign"><option value="">Set aisle at this store…</option>${st.aisles.map(a => `<option value="${a.id}">${a.num ? 'Aisle ' + esc(a.num) + ' · ' : ''}${esc(a.label)}</option>`).join('')}</select>` : ''}`;
  for (const a of st.aisles) {
    const its = here.filter(p => p.aisles[st.id] === a.id).sort((x, y) => x.got - y.got || x.name.localeCompare(y.name));
    if (its.length) h += `<div class="aislehead"><span class="anum ${a.num ? '' : 'none'}">${a.num ? esc(a.num) : '—'}</span><span class="alabel">${esc(a.label)}</span></div>` + its.map(p => row(p)).join('');
  }
  const loose = here.filter(p => !st.aisles.some(a => a.id === p.aisles[st.id]));
  if (loose.length) h += `<div class="aislehead"><span class="anum none">?</span><span class="alabel">No aisle set here yet</span></div>` + loose.map(p => row(p, true)).join('');
  if (elsewhere.length) h += `<details><summary>Bought at other stores (${elsewhere.length})</summary>${elsewhere.map(p => `<div class="row"><div data-edit="${p.id}">${thumb(p)}</div><div class="info" data-edit="${p.id}"><b>${esc(p.name)}</b><small>Only at ${esc(p.only_at.join(', '))}</small></div></div>`).join('')}</details>`;
  return h + listButtons();
}
const listButtons = () => `<button class="btn sec" data-act="addToList">+ Add something to the list</button>
  <button class="btn dis" data-act="scanSoon">📷 Scan to check item (Phase 2)</button>
  <button class="btn" data-act="finish">Finish trip</button>`;

function viewProducts() {
  const q = ui.q.toLowerCase();
  const ps = S.products.filter(p => !q || (p.name + ' ' + p.brand).toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  return `<input type="search" id="q" placeholder="Search products" value="${esc(ui.q)}">
    <button class="btn" data-act="newProduct">+ New product</button>` +
    (ps.map(p => { const loc = spotInfo(p.spot_id);
      return `<div class="row" data-edit="${p.id}">${thumb(p)}<div class="info"><b>${esc(p.name)}</b><small>${sub(p)}${loc ? ' · ' + esc(loc.room.name + ' / ' + loc.spot.name) : ''}</small></div></div>`; }).join('')
      || `<div class="empty">${S.products.length ? 'No matches.' : 'No products yet.'}</div>`);
}

function viewSetup() {
  let h = '';
  if (db.mode === 'demo') h += `<div class="banner">Demo mode: data stays on this phone. Fill in config.js to share with your household.</div>`;
  else h += `<div class="card"><b>${esc(HH.name)}</b><br><small>Invite code for your household:</small>
      <div class="code">${esc(HH.invite_code)}</div><small>She creates an account, picks "Join a home" and enters this code.</small></div>`;
  h += `<div class="sect">Rooms <small>(in the order you walk them)</small></div>`;
  S.rooms.forEach((r, i) => {
    h += `<div class="store"><button class="grow" data-room-edit="${r.id}">${esc(r.name)}<br><small>${r.spots.map(s => esc(s.name)).join(', ') || 'No spots'}</small></button>
      <button class="mini" data-room-mv="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button class="mini" data-room-mv="${i}" data-dir="1" ${i === S.rooms.length - 1 ? 'disabled' : ''}>↓</button></div>`;
  });
  h += `<button class="btn sec" data-act="newRoom">+ Add a room</button>`;
  h += `<div class="sect">Stores <small>(one per location)</small></div>`;
  for (const c of chains()) {
    h += `<div class="chainh">${esc(c)}</div>`;
    for (const st of S.stores.filter(s => s.chain === c))
      h += `<button class="store" data-store="${st.id}"><span>${esc(st.location || 'Location not named')}<br><small>${st.aisles.length} sections</small></span><span>›</span></button>`;
  }
  h += `<button class="btn sec" data-act="newStore">+ Add a store</button>`;
  h += `<div class="sect">Install</div><p class="hint">In Chrome, open the ⋮ menu and choose <b>Add to Home screen</b> (or <b>Install app</b>). It then opens like a normal app.</p>`;
  h += `<div class="sect">Account</div><p class="hint">Signed in as ${esc(USER?.email || '')}</p>`;
  if (db.mode === 'cloud') h += `<button class="btn danger" data-act="signOut">Sign out</button>`;
  else h += `<button class="btn danger" data-act="demoReset">Reset demo data</button>`;
  return h;
}

/* ======================= sheets ======================= */
function openSheet(html) { $('#panel').innerHTML = html; $('#sheet').classList.remove('hidden'); $('#panel').scrollTop = 0; }
function closeSheet() { $('#sheet').classList.add('hidden'); draft = null; draftPhoto = null; render(); }

function productSheet(id) {
  const p = id ? prodById(id) : null;
  draftPhoto = null;
  draft = p ? clone(p) : { id: uid(), household_id: HH.id, name: '', brand: '', brand_only: false, size: '', emoji: '🛒', photo_path: null, barcode: null,
    spot_id: S.rooms[0]?.spots[0]?.id || null, status: 'have', skip: false, extra: false, got: false, count_mode: false, qty: 0, min_qty: 1, target: 2,
    only_at: [], aisles: {}, _new: true };
  const d = draft;
  const spotOpts = S.rooms.map(r => `<optgroup label="${esc(r.name)}">${r.spots.map(s => `<option value="${s.id}" ${s.id === d.spot_id ? 'selected' : ''}>${esc(r.name)} / ${esc(s.name)}</option>`).join('')}</optgroup>`).join('');
  openSheet(`<h3>${d._new ? 'New product' : 'Edit product'}<button class="x" data-act="close" aria-label="Close">✕</button></h3>
    <label class="f">Photo</label>
    <div class="photoedit"><div id="ph">${thumb(d, true)}</div>
      <div><label class="btn sec inline">📷 Take / choose photo<input type="file" id="photoIn" accept="image/*" hidden></label>
      ${d.photo_path ? `<br><button class="chip" data-act="rmPhoto" style="margin-top:8px">Remove photo</button>` : ''}</div></div>
    <label class="f">Name</label><input type="text" id="fName" value="${esc(d.name)}" placeholder="e.g. 2% Milk">
    <label class="f">Brand</label><input type="text" id="fBrand" value="${esc(d.brand)}" placeholder="Leave blank = any brand">
    <div class="chips" style="margin-top:8px"><button class="chip ${d.brand_only ? 'on' : ''}" data-dbrand="only">This brand only</button><button class="chip ${d.brand_only ? '' : 'on'}" data-dbrand="ok">Other brands OK</button></div>
    <label class="f">Size / details</label><input type="text" id="fSize" value="${esc(d.size)}" placeholder="e.g. 2 L, salted">
    <label class="f">Icon (shown when there's no photo)</label><input type="text" id="fEmoji" value="${esc(d.emoji)}" maxlength="4">
    <label class="f">Where it lives at home</label><select id="fSpot">${spotOpts}</select>
    <label class="f">How to track it</label>
    <div class="chips"><button class="chip ${d.count_mode ? '' : 'on'}" data-dmode="simple">Have / Low / Out</button><button class="chip ${d.count_mode ? 'on' : ''}" data-dmode="count">Exact count</button></div>
    <div id="simpleBox" class="${d.count_mode ? 'hide' : ''}"><label class="f">Status</label><div class="chips">${['have', 'low', 'out'].map(k => `<button class="chip ${d.status === k ? 'on' : ''}" data-dstatus="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div></div>
    <div id="countBox" class="${d.count_mode ? '' : 'hide'}"><div class="nums">
      <div><label class="f">On hand</label><input type="number" id="fQty" min="0" inputmode="numeric" value="${d.qty}"></div>
      <div><label class="f">Low at</label><input type="number" id="fMin" min="0" inputmode="numeric" value="${d.min_qty}"></div>
      <div><label class="f">Stock up to</label><input type="number" id="fTarget" min="1" inputmode="numeric" value="${d.target}"></div></div>
      <p class="hint">Goes on the list when on hand ≤ "Low at". The list says how many to buy.</p></div>
    <div class="chips" style="margin-top:10px"><button class="chip ${d.skip ? 'on' : ''}" data-dskip="1">Out, but not needed right now</button></div>
    <label class="f">Aisle at each store</label>
    ${S.stores.map(st => `<div class="storeaisle"><span>${esc(storeName(st))}</span><select data-sa="${st.id}"><option value="">—</option>${st.aisles.map(a => `<option value="${a.id}" ${d.aisles[st.id] === a.id ? 'selected' : ''}>${a.num ? esc(a.num) + ' · ' : ''}${esc(a.label)}</option>`).join('')}</select></div>`).join('')}
    <label class="f">Only buy at (blank = anywhere)</label>
    <div class="chips">${chains().map(c => `<button class="chip ${d.only_at.includes(c) ? 'on' : ''}" data-only="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <button class="btn dis" data-act="scanSoon" style="margin-top:16px">▦ Scan barcode to fill in (Phase 2)</button>
    <button class="btn" data-act="saveProduct" id="saveBtn">Save</button>
    ${d._new ? '' : `<button class="btn danger" data-act="delProduct">Delete product</button>`}`);
}
function readProductForm() {
  const d = draft;
  d.name = $('#fName').value.trim(); d.brand = $('#fBrand').value.trim(); d.size = $('#fSize').value.trim();
  d.emoji = $('#fEmoji').value.trim() || '🛒'; d.spot_id = $('#fSpot').value || null;
  d.qty = Math.max(0, parseInt($('#fQty').value) || 0); d.min_qty = Math.max(0, parseInt($('#fMin').value) || 0);
  d.target = Math.max(1, parseInt($('#fTarget').value) || 1);
  document.querySelectorAll('[data-sa]').forEach(s => { if (s.value) d.aisles[s.dataset.sa] = s.value; else delete d.aisles[s.dataset.sa]; });
}

function listSheet(kind, id) {   // shared editor for stores (sections) and rooms (spots)
  if (kind === 'store') {
    const st = id ? storeById(id) : null;
    draft = st ? clone(st) : { id: uid(), household_id: HH.id, chain: '', location: '', sort: S.stores.length, aisles: SECTIONS.map(l => ({ id: sid(), num: '', label: l })), _new: true };
  } else {
    const r = id ? S.rooms.find(x => x.id === id) : null;
    draft = r ? clone(r) : { id: uid(), household_id: HH.id, name: '', sort: Math.max(-1, ...S.rooms.map(x => x.sort)) + 1, spots: [{ id: sid(), name: '' }], _new: true };
  }
  draft._kind = kind; drawListSheet();
}
function drawListSheet() {
  const d = draft, store = d._kind === 'store', items = store ? d.aisles : d.spots;
  openSheet(`<h3>${d._new ? (store ? 'New store' : 'New room') : (store ? 'Edit store' : 'Edit room')}<button class="x" data-act="close" aria-label="Close">✕</button></h3>
    ${store ? `<label class="f">Chain</label><input type="text" id="sChain" list="chainList" value="${esc(d.chain)}" placeholder="e.g. FreshCo">
      <datalist id="chainList">${chains().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <label class="f">Location</label><input type="text" id="sLoc" value="${esc(d.location)}" placeholder="e.g. Kanata, or Main St">
      <label class="f">Sections in walking order (aisle # optional)</label>`
      : `<label class="f">Room name</label><input type="text" id="sChain" value="${esc(d.name)}" placeholder="e.g. Basement">
      <label class="f">Spots in this room</label>`}
    ${items.map((a, i) => `<div class="aisleedit">
      ${store ? `<input type="text" class="n" data-an="${i}" value="${esc(a.num)}" placeholder="#">` : ''}
      <input type="text" data-al="${i}" value="${esc(store ? a.label : a.name)}" placeholder="${store ? 'Section name' : 'e.g. Fridge'}">
      <button data-mv="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Up">↑</button>
      <button data-mv="${i}" data-dir="1" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Down">↓</button>
      <button data-rma="${i}" aria-label="Remove">✕</button></div>`).join('')}
    <button class="btn sec" data-act="addItem">+ Add ${store ? 'section' : 'spot'}</button>
    <button class="btn" data-act="saveList">Save</button>
    ${d._new ? '' : `${store ? '<button class="btn sec" data-act="dupStore">Copy layout to a new location</button>' : ''}<button class="btn danger" data-act="delList">Delete ${store ? 'store' : 'room'}</button>`}`);
}
function readListForm() {
  const d = draft, store = d._kind === 'store', items = store ? d.aisles : d.spots;
  if (store) { d.chain = $('#sChain').value.trim(); d.location = $('#sLoc').value.trim(); } else d.name = $('#sChain').value.trim();
  document.querySelectorAll('[data-an]').forEach(el => items[+el.dataset.an].num = el.value.trim());
  document.querySelectorAll('[data-al]').forEach(el => { items[+el.dataset.al][store ? 'label' : 'name'] = el.value.trim(); });
}

function addToListSheet() {
  const ps = S.products.filter(p => !onList(p)).sort((a, b) => a.name.localeCompare(b.name));
  openSheet(`<h3>Add to list<button class="x" data-act="close" aria-label="Close">✕</button></h3>
    <p class="hint">Things you still have at home but want to grab anyway.</p>
    ${ps.map(p => `<div class="row" data-addlist="${p.id}">${thumb(p)}<div class="info"><b>${esc(p.name)}</b><small>${sub(p)}</small></div><span class="plus">＋</span></div>`).join('') || '<div class="empty">Everything is already on the list.</div>'}
    <button class="btn sec" data-act="newProduct">+ New product</button>`);
}

/* ======================= actions ======================= */
async function saveProduct() {
  readProductForm();
  const d = draft;
  if (!d.name) return toast('Give it a name');
  const btn = $('#saveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
  const old = prodById(d.id);
  if (draftPhoto) {
    try {
      const path = await db.uploadPhoto(HH.id, d.id, draftPhoto.blob, draftPhoto.dataUrl);
      if (old?.photo_path && old.photo_path !== path) db.deletePhoto(old.photo_path);
      d.photo_path = path;
      await db.loadPhotoUrls([path]);
    } catch (e) { toast('Photo upload failed (no signal?). Saved without the new photo.'); }
  }
  const isNew = d._new; delete d._new;
  const i = S.products.findIndex(x => x.id === d.id);
  if (i < 0) S.products.push(d); else S.products[i] = d;
  saveP(d); toast(isNew ? 'Product added' : 'Saved'); closeSheet();
}
function saveList() {
  readListForm();
  const d = draft, store = d._kind === 'store';
  if (store && !d.chain) return toast('Enter the chain name');
  if (!store && !d.name) return toast('Enter a room name');
  if (store) d.aisles = d.aisles.filter(a => a.num || a.label); else d.spots = d.spots.filter(s => s.name);
  const list = store ? S.stores : S.rooms, table = store ? 'stores' : 'rooms';
  if (d._copyFrom) {           // carry product aisle assignments over to the copied location
    const { from, map } = d._copyFrom;
    S.products.forEach(p => { const a = p.aisles[from]; if (a && map[a]) { p.aisles[d.id] = map[a]; saveP(p); } });
  }
  const isNew = d._new; ['_new', '_kind', '_copyFrom'].forEach(k => delete d[k]);
  const i = list.findIndex(x => x.id === d.id);
  if (i < 0) list.push(d); else list[i] = d;
  db.save(table, d); sortAll(); toast(isNew ? 'Added' : 'Saved'); closeSheet();
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-room],[data-status],[data-qty],[data-edit],[data-got],[data-act],[data-store],[data-room-edit],[data-room-mv],[data-dstatus],[data-dmode],[data-dbrand],[data-dskip],[data-only],[data-mv],[data-rma],[data-addlist]');
  if (!t) { if (e.target.id === 'sheet') closeSheet(); return; }
  const ds = t.dataset;
  if (ds.tab) { ui.tab = ds.tab; $('#sheet').classList.add('hidden'); draft = null; render(); window.scrollTo(0, 0); return; }
  if (ds.room) { ui.closed[ds.room] = !ui.closed[ds.room]; render(); return; }
  if (ds.status) {
    const p = prodById(ds.id);
    if (ds.status === 'skip') { p.skip = !p.skip; if (p.skip) p.got = false; }
    else { p.skip = false; p.status = ds.status; if (ds.status === 'have') { p.got = false; p.extra = false; } }
    saveP(p); render(); return;
  }
  if (ds.qty) { const p = prodById(ds.id); p.qty = Math.max(0, p.qty + (+ds.qty)); saveP(p); render(); return; }
  if (ds.got) { const p = prodById(ds.got); p.got = !p.got; saveP(p); render(); return; }
  if (ds.edit) { productSheet(ds.edit); return; }
  if (ds.store) { listSheet('store', ds.store); return; }
  if (ds.roomEdit) { listSheet('room', ds.roomEdit); return; }
  if (ds.roomMv !== undefined) {
    const i = +ds.roomMv, j = i + (+ds.dir), a = S.rooms[i], b = S.rooms[j];
    S.rooms.forEach((r, k) => r.sort = k); [a.sort, b.sort] = [b.sort, a.sort];
    S.rooms.forEach(r => db.save('rooms', r)); sortAll(); render(); return;
  }
  if (ds.addlist) { const p = prodById(ds.addlist); p.extra = true; saveP(p); toast(p.name + ' added'); addToListSheet(); render(); return; }
  if (ds.dstatus) { draft.status = ds.dstatus; t.parentNode.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === t)); return; }
  if (ds.dmode) {
    draft.count_mode = ds.dmode === 'count'; t.parentNode.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === t));
    $('#simpleBox').classList.toggle('hide', draft.count_mode); $('#countBox').classList.toggle('hide', !draft.count_mode); return;
  }
  if (ds.dbrand) { draft.brand_only = ds.dbrand === 'only'; t.parentNode.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === t)); return; }
  if (ds.dskip) { draft.skip = !draft.skip; t.classList.toggle('on', draft.skip); return; }
  if (ds.only) { const c = ds.only, i = draft.only_at.indexOf(c); i < 0 ? draft.only_at.push(c) : draft.only_at.splice(i, 1); t.classList.toggle('on'); return; }
  if (ds.mv !== undefined) {
    readListForm(); const items = draft._kind === 'store' ? draft.aisles : draft.spots;
    const i = +ds.mv, j = i + (+ds.dir); [items[i], items[j]] = [items[j], items[i]]; drawListSheet(); return;
  }
  if (ds.rma !== undefined) { readListForm(); (draft._kind === 'store' ? draft.aisles : draft.spots).splice(+ds.rma, 1); drawListSheet(); return; }

  switch (ds.act) {
    case 'close': closeSheet(); break;
    case 'newProduct': productSheet(null); break;
    case 'addToList': addToListSheet(); break;
    case 'scanSoon': toast('Barcode scanning comes in Phase 2'); break;
    case 'rmPhoto': readProductForm(); draftPhoto = null; db.deletePhoto(draft.photo_path); draft.photo_path = null; $('#ph').innerHTML = thumb(draft, true); t.remove(); break;
    case 'saveProduct': await saveProduct(); break;
    case 'delProduct':
      if (arm('dp' + draft.id)) { db.deletePhoto(draft.photo_path); db.remove('products', draft.id); S.products = S.products.filter(x => x.id !== draft.id); toast('Deleted'); closeSheet(); }
      break;
    case 'newStore': listSheet('store'); break;
    case 'newRoom': listSheet('room'); break;
    case 'addItem': readListForm(); (draft._kind === 'store' ? draft.aisles.push({ id: sid(), num: '', label: '' }) : draft.spots.push({ id: sid(), name: '' })); drawListSheet(); break;
    case 'saveList': saveList(); break;
    case 'dupStore': {
      readListForm(); const map = {};
      const aisles = draft.aisles.map(a => { const n = { ...a, id: sid() }; map[a.id] = n.id; return n; });
      draft = { id: uid(), household_id: HH.id, chain: draft.chain, location: '', sort: S.stores.length, aisles, _new: true, _kind: 'store', _copyFrom: { from: draft.id, map } };
      drawListSheet(); toast('Layout copied. Name the location and adjust.'); break;
    }
    case 'delList': {
      const store = draft._kind === 'store';
      if (!arm('dl' + draft.id)) break;
      if (store) { S.stores = S.stores.filter(x => x.id !== draft.id); db.remove('stores', draft.id); }
      else { S.rooms = S.rooms.filter(x => x.id !== draft.id); db.remove('rooms', draft.id); }
      toast('Deleted'); closeSheet(); break;
    }
    case 'finish': {
      let n = 0;
      S.products.forEach(p => { if (p.got) { p.got = false; p.extra = false; p.status = 'have'; if (p.count_mode) p.qty = Math.max(p.qty, p.target); saveP(p); n++; } });
      toast(n ? `${n} item${n > 1 ? 's' : ''} marked as Have` : 'Tick items off first'); render(); break;
    }
    case 'signOut': if (arm('so')) { await db.signOut(); location.reload(); } break;
    case 'demoReset': if (arm('dr')) { db.demoReset(); location.reload(); } break;
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'storeSel') { ui.storeId = t.value; lsSet('restock-store', t.value); render(); return; }
  if (t.dataset.assign) { const p = prodById(t.dataset.assign); if (t.value) { p.aisles[ui.storeId] = t.value; saveP(p); toast('Aisle saved for this store'); render(); } return; }
  if (t.id === 'photoIn' && t.files[0]) {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const m = 800, k = Math.min(1, m / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const dataUrl = c.toDataURL('image/jpeg', 0.8);
        c.toBlob(blob => { draftPhoto = { blob, dataUrl }; $('#ph').innerHTML = thumb(draft, true); }, 'image/jpeg', 0.8);
      };
      img.src = r.result;
    };
    r.readAsDataURL(t.files[0]);
  }
});
document.addEventListener('input', e => { if (e.target.id === 'q') { ui.q = e.target.value; render(); } });

/* ======================= sign-in & household screens ======================= */
function bareScreen(html) { document.body.classList.add('bare'); $('#view').innerHTML = html; }
function authScreen(msg = '') {
  bareScreen(`<div class="auth"><div class="logo">Restock</div><p class="hint">Your shared grocery list & home inventory.</p>
    ${msg ? `<div class="banner">${esc(msg)}</div>` : ''}
    <form id="authForm"><label class="f">Email</label><input type="email" id="aEmail" autocomplete="email" required>
    <label class="f">Password</label><input type="password" id="aPass" autocomplete="current-password" minlength="6" required>
    <button class="btn" type="submit" data-mode="in">Sign in</button>
    <button class="btn sec" type="submit" data-mode="up">Create account</button></form></div>`);
  let modeBtn = 'in';
  document.querySelectorAll('#authForm button').forEach(b => b.addEventListener('click', () => modeBtn = b.dataset.mode));
  $('#authForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const email = $('#aEmail').value.trim(), pass = $('#aPass').value;
    try {
      if (modeBtn === 'up') {
        const res = await db.signUp(email, pass);
        if (!res.session) return authScreen('Account created. Check your email for a confirmation link, then come back and sign in.');
      } else await db.signIn(email, pass);
      boot();
    } catch (err) { authScreen(err.message || 'Sign-in failed'); }
  });
}
function householdScreen(msg = '') {
  bareScreen(`<div class="auth"><div class="logo">Restock</div>
    ${msg ? `<div class="banner">${esc(msg)}</div>` : ''}
    <label class="f">Your name</label><input type="text" id="hName" placeholder="e.g. Ryno">
    <div class="sect">Start a new home</div>
    <p class="hint">Comes with starter rooms and your stores (Walmart, Longo's, Farm Boy, Costco, Canadian Tire), ready to edit.</p>
    <button class="btn" id="hCreate">Create our home</button>
    <div class="sect">Or join one</div>
    <label class="f">Invite code</label><input type="text" id="hCode" placeholder="6 letters/numbers" autocapitalize="characters">
    <button class="btn sec" id="hJoin">Join a home</button>
    <button class="btn danger" id="hOut" style="margin-top:24px">Sign out</button></div>`);
  $('#hCreate').onclick = async () => {
    try {
      const id = await db.createHousehold('Home', $('#hName').value.trim());
      starterRooms(id).forEach(r => db.save('rooms', r));
      starterStores(id).forEach(s => db.save('stores', s));
      await db.flush(); boot();
    } catch (err) { householdScreen(err.message); }
  };
  $('#hJoin').onclick = async () => {
    try { await db.joinHousehold($('#hCode').value, $('#hName').value.trim()); boot(); }
    catch (err) { householdScreen(err.message); }
  };
  $('#hOut').onclick = async () => { await db.signOut(); location.reload(); };
}

/* ======================= boot & sync ======================= */
async function refresh() {
  try {
    const data = await db.loadAll(HH.id);
    S = data; sortAll();
    await db.loadPhotoUrls(S.products.map(p => p.photo_path));
    render();
  } catch (e) { syncBadge(db.pendingCount()); toast('No connection: showing your saved copy'); }
}
function onRemote(table, p) {
  const pend = db.pendingIds();
  if (p.eventType === 'DELETE') { const id = p.old?.id; if (!id || pend.has(id)) return; S[table] = S[table].filter(r => r.id !== id); }
  else {
    const row = p.new; if (!row || row.household_id !== HH.id || pend.has(row.id)) return;
    if (draft && draft.id === row.id) return;            // don't yank an item out from under an open editor
    const list = S[table], i = list.findIndex(r => r.id === row.id);
    if (i >= 0) list[i] = row; else list.push(row);
    if (table === 'products' && row.photo_path) db.loadPhotoUrls([row.photo_path]).then(ok => ok && queueRender());
  }
  sortAll(); queueRender();
}

async function boot() {
  document.body.classList.remove('bare');
  await db.init();
  db.setHandlers({ onError: e => toast('Sync problem: ' + (e.message || e)), onOutboxChange: n => syncBadge(n) });
  if (db.mode === 'cloud') {
    USER = await db.currentUser();
    if (!USER) return authScreen();
    try { HH = await db.myHousehold(); }
    catch { HH = lsGet('restock-hh', null); }                  // offline: use the household we saw last
    if (!HH) return householdScreen();
    lsSet('restock-hh', HH);
  } else { USER = { email: 'demo mode' }; HH = { id: 'demo', name: 'Demo home', invite_code: '—' }; }
  document.body.classList.remove('bare');
  loadCache(); render(); syncBadge(db.pendingCount());
  await refresh();
  db.subscribe(HH.id, onRemote);
  db.flush();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && HH) { db.flush(); refresh(); } });
window.addEventListener('online', () => { syncBadge(db.pendingCount()); if (HH) refresh(); });
window.addEventListener('offline', () => syncBadge(db.pendingCount()));

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
boot();
