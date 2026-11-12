// AVTOMATIK YARATILGAN (build.py). Tahrirlash uchun server/ papkasidagi fayllarni o‘zgartiring.
import { getStore } from "@netlify/blobs";
// Avtomatik yaratilgan (build.py) — katalog hajmlari
const MODEL_COUNTS = [11, 3, 7, 4, 5, 6, 4, 4, 3, 3, 3, 4, 3, 4, 7, 6, 2, 6, 3, 3, 3, 13, 13, 8, 7, 3, 5, 7, 4, 2, 3, 2, 2, 8, 2, 2, 4, 3, 6, 7, 10, 5, 5, 3, 3];
const COLOR_COUNT = 8;
const FINISH_COUNT = 3;
const RIM_COUNT = 4;

// Garaj serveri. Saqlash joyidan mustaqil (Netlify Blobs yoki sinov uchun xotira).
// Masshtab: har bir obunachi alohida yozuv; turargoh 200 talik bo‘laklarda saqlanadi —
// hech qachon butun baza qayta o‘qilmaydi, shuning uchun 100 ming va undan ko‘p odamda ham tez.

const NICK_RE = /^[a-z0-9._]{2,30}$/;
const PIN_RE = /^\d{2}$/;
const MAX_FAILS = 5;
const LOCKS = [10 * 60e3, 60 * 60e3, 6 * 3600e3, 24 * 3600e3]; // 2 xonali PIN: blok har safar uzayadi
const CHUNK = 200;
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normNick(raw) {
  const n = String(raw ?? "").trim().toLowerCase().replace(/^@+/, "");
  return NICK_RE.test(n) ? n : null;
}
function validCar(c) {
  if (!c || typeof c !== "object") return null;
  const b = c.b | 0, m = c.m | 0, col = c.c | 0, f = c.f | 0, r = c.r | 0;
  if (b < 0 || b >= MODEL_COUNTS.length || m < 0 || m >= MODEL_COUNTS[b]) return null;
  if (col < 0 || col >= COLOR_COUNT || f < 0 || f >= FINISH_COUNT || r < 0 || r >= RIM_COUNT) return null;
  return { b, m, c: col, f, r };
}
const carStr = (c) => `${c.b}.${c.m}.${c.c}.${c.f}.${c.r}`;
async function hashPin(nick, pin, salt, iters) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(`${salt}|${nick}`), iterations: iters }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const cdn = (sec) => ({ "cache-control": "public, max-age=0, must-revalidate", "netlify-cdn-cache-control": `public, max-age=${sec}, stale-while-revalidate=${sec * 4}` });

/**
 * store = { users, lot, meta } — har biri: get(key)->{data,etag}|null, put(key,data,{ifNew}|{ifMatch})->boolean
 */
function makeApi(store, env = {}) {
  const salt = env.SECRET_SALT || "garaj-v2", iters = env.PBKDF2_ITER || 60000;
  const now = () => (env.now ? env.now() : Date.now());
  const human = (ms) => ms >= 3600e3 ? `${Math.round(ms / 3600e3)} soat` : `${Math.max(1, Math.round(ms / 60e3))} daqiqa`;
  let statsFlight = null;

  // o‘qish-o‘zgartirish-yozish; boshqa kimdir shu payt yozsa, qayta urinadi (hech narsa yo‘qolmaydi)
  async function cas(area, key, fn, init) {
    for (let a = 0; a < 14; a++) {
      const cur = await area.get(key);
      const next = fn(cur ? structuredClone(cur.data) : init());
      if (next === undefined) return cur ? cur.data : null;
      if (await area.put(key, next, cur ? { ifMatch: cur.etag } : { ifNew: true })) return next;
      await sleep(5 + Math.random() * 25 * (a + 1));
    }
    throw new HttpError(503, "Server hozir band. Bir ozdan keyin qayta urinib ko’ring");
  }
  const config = async () => (await store.meta.get("config"))?.data || {};
  async function alloc(count) {
    let start = 0;
    await cas(store.meta, "config", (c) => { start = c.next || 0; c.next = start + count; return c; }, () => ({}));
    return start;
  }
  // Saqlash bo‘lakni o‘zgartirmaydi: alohida kichik "belgi" yozadi (har kim o‘z kaliti — to‘qnashuv yo‘q).
  // Bo‘lak o‘qilganda belgilar qo‘shiladi va vaqti-vaqti bilan bo‘lakka yig‘ib qo‘yiladi.
  async function setSlot(p, entry) {
    const k = Math.floor(p / CHUNK), i = p % CHUNK, ts = String(now()).padStart(15, "0");
    await store.lot.put(`m${k}/${String(i).padStart(3, "0")}/${ts}/${entry[0]}/${entry[1] || "-"}/${entry[2] | 0}`, 1, {});
  }
  function applyMarks(arr, keys) {
    for (const key of keys) {
      const q = key.split("/"); if (q.length !== 5 && q.length !== 6) continue;
      const i = +q[1], ts = +q[2], e = arr[i];
      if (i >= 0 && i < CHUNK && (!e || (e[2] || 0) <= ts)) arr[i] = [q[3], q[4] === "-" ? "" : q[4], ts, q.length === 6 ? +q[5] || 0 : 0, e && e[0] === q[3] ? e[4] : 0];
    }
    return arr;
  }
  async function chunkData(k, compact) {
    const r = await store.lot.get("c" + k), keys = await store.lot.list(`m${k}/`);
    const arr = applyMarks(r?.data ? r.data : new Array(CHUNK).fill(null), keys);
    if (compact && keys.length) {
      try { await cas(store.lot, "c" + k, (a) => applyMarks(a, keys), () => new Array(CHUNK).fill(null)); await Promise.all(keys.map((x) => store.lot.del(x))); } catch {}
    }
    return arr;
  }

  async function status(nick) {
    const cfg = await config(), rec = await store.users.get(nick);
    if (rec?.data.rm && !rec.data.ph) return { status: "free", car: null, p: null, lv: 0, removed: rec.data.rm };
    if (rec?.data.ph) return { status: "claimed", car: rec.data.car || null, p: rec.data.p ?? null, lv: rec.data.lv || 0 };
    if (rec) return { status: "free", car: rec.data.car || null, p: rec.data.p ?? null, lv: rec.data.lv || 0 };
    return { status: "free", car: null, p: null };
  }

  async function checkPin(nick, pin) {
    if (!PIN_RE.test(String(pin ?? ""))) throw new HttpError(400, "PIN 2 ta raqamdan iborat bo’lishi kerak");
    const rec = await store.users.get(nick);
    if (!rec?.data.ph) throw new HttpError(404, "Bu nik hali tasdiqlanmagan");
    const d = rec.data;
    if (d.lu && d.lu > now()) throw new HttpError(429, `Juda ko’p xato urinish. ${human(d.lu - now())}dan keyin urinib ko’ring`);
    if (same(await hashPin(nick, String(pin), salt, iters), d.ph)) {
      if (d.f || d.lc || d.lu) { d.f = 0; d.lc = 0; delete d.lu; await store.users.put(nick, d, { ifMatch: rec.etag }); }
      return rec;
    }
    d.f = (d.f || 0) + 1; let left = MAX_FAILS - d.f, lockMs = 0;
    if (d.f >= MAX_FAILS) { d.lc = (d.lc || 0) + 1; lockMs = LOCKS[Math.min(d.lc - 1, LOCKS.length - 1)]; d.lu = now() + lockMs; d.f = 0; left = 0; }
    await store.users.put(nick, d, { ifMatch: rec.etag });
    throw new HttpError(403, left > 0 ? `PIN noto’g’ri. Qolgan urinish: ${left}` : `Juda ko’p xato urinish. ${human(lockMs)}dan keyin urinib ko’ring`);
  }

  async function setPin(nick, pin, carIn) {
    if (!PIN_RE.test(String(pin ?? ""))) throw new HttpError(400, "PIN 2 ta raqamdan iborat bo’lishi kerak");
    const cfg = await config(), rec = await store.users.get(nick);
    if (rec?.data.ph) throw new HttpError(409, "Bu nikning egasi allaqachon bor");
    const ph = await hashPin(nick, String(pin), salt, iters), car = carIn ? validCar(carIn) : null;
    const fromScratch = !rec || rec.data.rm;
    const data = { ...(fromScratch ? {} : rec.data), ph, t: now(), ...(fromScratch ? { c: now() } : {}), ...(car ? { car } : {}) };
    if (!(await store.users.put(nick, data, rec ? { ifMatch: rec.etag } : { ifNew: true }))) throw new HttpError(409, "Bu nikni boshqa kimdir hozirgina tasdiqladi");
    const back = await store.users.get(nick);
    if (!back || back.data.ph !== ph) throw new HttpError(409, "Bu nikni boshqa kimdir hozirgina tasdiqladi");
    let p = fromScratch ? null : rec?.data.p;             // joy faqat g‘olibga beriladi (bo‘sh joylar qolmaydi)
    if (p == null) { p = await alloc(1); await cas(store.users, nick, (d) => { d.p = p; return d; }, () => ({})); }
    if (car || fromScratch || rec?.data.p == null) await setSlot(p, [nick, car ? carStr(car) : "", data.lv || 0]);
    return { ok: true, car: data.car || null, p };
  }

  async function save(nick, pin, carIn) {
    const car = validCar(carIn);
    if (!car) throw new HttpError(400, "Mashina tanlovi noto’g’ri");
    await checkPin(nick, pin);
    let p = null, lv = 0;
    await cas(store.users, nick, (d) => { d.car = car; d.t = now(); p = d.p; lv = d.lv || 0; return d; }, () => { throw new HttpError(404, "Topilmadi"); });
    if (p == null) { p = await alloc(1); await cas(store.users, nick, (d) => { d.p = p; return d; }, () => ({})); }
    await setSlot(p, [nick, carStr(car), lv]);
    return { ok: true, car, p, lv };
  }

  const dayNo = () => Math.floor((now() + 5 * 3600e3) / 86400e3);            // Toshkent vaqti bo‘yicha kun
  function h32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  async function daily() {
    const day = dayNo(), cur = (await store.meta.get("daily"))?.data;
    if (cur && cur.day === day) return cur.nick ? cur : null;
    const K = Math.ceil(((await config()).next || 0) / CHUNK); let pick = null;
    for (let t = 0; t < 12 && K && !pick; t++) {
      const k = (h32("d" + day) + t * 7919) % K, arr = await chunkData(k, false);
      const c = arr.map((e, i) => (e && e[1] ? [e[0], k * CHUNK + i] : null)).filter(Boolean);
      if (c.length) pick = c[h32("p" + day) % c.length];
    }
    const d = { day, nick: pick ? pick[0] : null, p: pick ? pick[1] : null }; await store.meta.put("daily", d, {}); return pick ? d : null;
  }
  async function lotMeta() {
    const c = await config(), f = (await store.meta.get("featured"))?.data || null;
    let pick = null;                                  // CHEMPION: admin belgilaydi, ro‘yxat yangilansa ham o‘zgarmaydi
    if (f && f.nick) { const r = await store.users.get(f.nick); if (r && r.data && r.data.p != null && r.data.p < (c.next || 0)) pick = { nick: f.nick, p: r.data.p }; }
    return { n: c.next || 0, chunk: CHUNK, ig: c.ig || "", featured: pick };
  }
  async function lotChunk(k) { k = Math.max(0, k | 0); return { k, items: (await chunkData(k, true)).map((e) => e && [e[0], e[1], e[3] || 0, e[4] === 0 ? 0 : 1]) }; }
  async function allChunks(fnEach) {
    const n = (await config()).next || 0, K = Math.ceil(n / CHUNK);
    for (let k = 0; k < K; k += 40) {
      const part = await Promise.all(Array.from({ length: Math.min(40, K - k) }, (_, j) => chunkData(k + j, false)));
      part.forEach((arr) => arr.forEach((e) => e && fnEach(e)));
    }
  }
  async function computeStats() {
    const brands = {}; let claimed = 0, total = 0;
    await allChunks((e) => { total++; if (e[1]) { claimed++; const b = +e[1].split(".")[0]; brands[b] = (brands[b] || 0) + 1; } });
    const st = { t: now(), total, claimed, brands: Object.keys(brands).map((b) => ({ b: +b, n: brands[b] })).sort((a, b) => b.n - a.n) };
    await store.meta.put("stats", st, {}); return st;
  }
  async function stats() {
    const st = (await store.meta.get("stats"))?.data;
    if (st && now() - st.t < (st.total < 2000 ? 30e3 : 10 * 60e3)) return st;
    if (!statsFlight) statsFlight = computeStats().finally(() => { statsFlight = null; });
    return statsFlight;
  }

  async function admin(body, ip = "?") {
    const fk = "af-" + h32(String(ip)), fr = (await store.meta.get(fk))?.data;       // admin kalitini taxmin qilishdan himoya (IP bo‘yicha)
    if (fr && fr.until > now()) throw new HttpError(429, `Juda ko’p noto’g’ri urinish. ${human(fr.until - now())}dan keyin urinib ko’ring`);
    if (!env.ADMIN_KEY || !same(String(body.key || ""), env.ADMIN_KEY)) {
      const n = ((fr && fr.until > 0 && fr.until <= now() ? 0 : fr?.n) || 0) + 1;
      await store.meta.put(fk, n >= 8 ? { n: 0, until: now() + 30 * 60e3 } : { n, until: 0 }, {});
      throw new HttpError(403, "Ruxsat yo’q");
    }
    if (fr && (fr.n || fr.until)) await store.meta.put(fk, { n: 0, until: 0 }, {});
    if (body.action === "sync-start") {
      const sid = now(); await store.meta.put("sync", { sid, started: sid }, {}); return { ok: true, sid };
    }
    if (body.action === "import") {
      const sid = +body.sid || 1;
      const list = [...new Set((Array.isArray(body.nicks) ? body.nicks : []).slice(0, 600).map(normNick).filter(Boolean))];
      const exists = [];
      for (let i = 0; i < list.length; i += 50) exists.push(...(await Promise.all(list.slice(i, i + 50).map((n) => store.users.get(n)))));
      const marks = {}, add = (p, n) => (marks[Math.floor(p / CHUNK)] ||= []).push([p % CHUNK, n]);
      list.forEach((n, i) => { const r = exists[i]; if (r && r.data.p != null) add(r.data.p, n); });
      const freshIdx = list.map((_, i) => i).filter((i) => !exists[i] || exists[i].data.p == null);
      // 1-bosqich: yozuvni yaratish (joysiz). Faqat g‘olib bo‘lganlar keyingi bosqichga o‘tadi — shuning uchun joylar bekorga band bo‘lmaydi
      const made = [];
      for (let i = 0; i < freshIdx.length; i += 50) {
        const part = freshIdx.slice(i, i + 50);
        const res = await Promise.all(part.map((k) => { const old = exists[k]; return store.users.put(list[k], { a: 1, c: now() }, old ? { ifMatch: old.etag } : { ifNew: true }); }));
        res.forEach((ok, j) => ok && made.push(list[part[j]]));
      }
      // 2-bosqich: faqat yaratilganlarga joy berish
      let placed = 0;
      if (made.length) {
        const start = await alloc(made.length);
        for (let i = 0; i < made.length; i += 50) {
          await Promise.all(made.slice(i, i + 50).map((n, j) => cas(store.users, n, (d) => { d.p = start + i + j; return d; }, () => ({ a: 1, c: now() }))));
        }
        made.forEach((n, i) => { add(start + i, n); placed++; });
      }
      await Promise.all(Object.keys(marks).map((k) => cas(store.lot, "c" + k, (arr) => { marks[k].forEach(([i, n]) => { if (arr[i] && arr[i][0] === n) arr[i][4] = sid; else if (!arr[i]) arr[i] = [n, "", 0, 0, sid]; }); return arr; }, () => new Array(CHUNK).fill(null))));
      const cfg = await cas(store.meta, "config", (c) => { c.allow = (c.allow || 0) + placed; return c; }, () => ({}));
      return { ok: true, received: list.length, added: placed, verified: list.length - freshIdx.length, total: cfg.next };
    }
    if (body.action === "wipe") {     // faqat sinov ma‘lumotlarini tozalash uchun (hammasini o‘chiradi!)
      if (body.confirm !== "HAMMASINI_OCHIR") throw new HttpError(400, "Tasdiqlash so’zi noto’g’ri");
      const ks = [...(await store.users.list("")).map((k) => [store.users, k]), ...(await store.lot.list("")).map((k) => [store.lot, k])];
      const LIMIT = 300, batch = ks.slice(0, LIMIT);
      for (let i = 0; i < batch.length; i += 50) await Promise.all(batch.slice(i, i + 50).map(([a, k]) => a.del(k)));
      const left = ks.length - batch.length;
      if (left === 0) for (const m of ["config", "stats", "daily", "featured", "sync"]) { try { await store.meta.del(m); } catch {} }
      return { ok: true, deleted: batch.length, left };
    }
    if (body.action === "sync-finish") {        // bugungi ro‘yxatda yo‘qlarni chiqarib yuborish (bo‘laklab, vaqt chegarasiga sig‘ishi uchun)
      const sid = +body.sid, from = Math.max(0, body.from | 0), STEP = 5, GRACE = body.strict ? 0 : 24 * 3600e3;
      const sy = (await store.meta.get("sync"))?.data; if (!sid || !sy || sy.sid !== sid) throw new HttpError(400, "Sinxronlash sessiyasi topilmadi");
      const K = Math.ceil(((await config()).next || 0) / CHUNK); let removed = 0, kept = 0;
      for (let k = from; k < Math.min(K, from + STEP); k++) {
        const arr = await chunkData(k, true), gone = [];
        const cand = arr.map((e, i) => (e && e[4] !== sid ? [i, e[0]] : null)).filter(Boolean);
        const recs = await Promise.all(cand.map(([, n]) => store.users.get(n)));       // parallel: vaqt chegarasiga sig‘adi
        cand.forEach(([i, n], j) => { const u = recs[j]; if (u && u.data.c && now() - u.data.c < GRACE) kept++; else gone.push([i, n]); }); // 1 kunlik imtiyoz
        if (gone.length) {
          await cas(store.lot, "c" + k, (a) => { gone.forEach(([i, n]) => { if (a[i] && a[i][0] === n) a[i] = null; }); return a; }, () => new Array(CHUNK).fill(null));
          await Promise.all(gone.map(([, n]) => store.users.put(n, { rm: now() }, {})));
          removed += gone.length;
        }
      }
      const next = from + STEP; return { ok: true, removed, kept, next: next < K ? next : null, done: next >= K };
    }
    if (body.action === "compact") {      // bo‘sh kataklarni olib tashlab, mashinalarni zich joylashtiradi (bo‘laklab)
      const phase = body.phase === "chunks" ? "chunks" : "users", from = Math.max(0, body.from | 0), LIM = 120;
      const cfg = await config(), n0 = cfg.next || 0, K = Math.ceil(n0 / CHUNK);
      if (K > 120) throw new HttpError(400, "Zichlash 24 000 tagacha mashinada ishlaydi");
      const E = [];
      for (let k = 0; k < K; k += 20) {
        const part = await Promise.all(Array.from({ length: Math.min(20, K - k) }, (_, i) => chunkData(k + i, true)));
        part.forEach((arr, i) => arr.forEach((e, j) => e && E.push([(k + i) * CHUNK + j, e])));
      }
      const m = E.length, holes = n0 - m;
      if (holes <= 0) return { ok: true, holes: 0, done: true, total: m };
      if (phase === "users") {
        const mv = []; E.forEach(([old, e], j) => { if (old !== j) mv.push([e[0], j]); });
        const part = mv.slice(from, from + LIM);
        for (let i = 0; i < part.length; i += 40) await Promise.all(part.slice(i, i + 40).map(([nick, j]) => cas(store.users, nick, (d) => { d.p = j; return d; }, () => ({}))));
        const next = from + LIM;
        return { ok: true, holes, done: false, nextPhase: next < mv.length ? "users" : "chunks", next: next < mv.length ? next : 0 };
      }
      const newK = Math.ceil(m / CHUNK);
      for (let c = 0; c < newK; c++) { const arr = E.slice(c * CHUNK, (c + 1) * CHUNK).map(([, e]) => e); while (arr.length < CHUNK) arr.push(null); await store.lot.put("c" + c, arr, {}); }
      for (let c = newK; c < K; c++) await store.lot.del("c" + c);
      await cas(store.meta, "config", (c) => { c.next = m; return c; }, () => ({}));
      for (const key of ["daily", "featured"]) {      // chempionning joyi ham yangilanadi
        const d = (await store.meta.get(key))?.data;
        if (d && d.nick) { const r = await store.users.get(d.nick); if (r && r.data.p != null) await store.meta.put(key, { ...d, p: r.data.p }, {}); else await store.meta.del(key); }
      }
      return { ok: true, holes, done: true, total: m };
    }
    if (body.action === "reset") {
      const nick = normNick(body.nick); if (!nick) throw new HttpError(400, "Nik noto’g’ri");
      if (!(await store.users.get(nick))) throw new HttpError(404, "Topilmadi");
      await cas(store.users, nick, (d) => { delete d.ph; delete d.f; delete d.lu; delete d.lc; return d; }, () => ({}));
      return { ok: true };
    }
    if (body.action === "selftest") {        // haqiqiy Netlify Blobs'da asosiy kafolatlarni tekshiradi
      const k = "zz_selftest_" + now(), mk = "mT" + now() + "/000/1/x/-/0", r = {};
      try {
        r.create = await store.users.put(k, { v: 1 }, { ifNew: true });
        r.secondCreateBlocked = !(await store.users.put(k, { v: 2 }, { ifNew: true }));
        const a1 = await store.users.get(k); r.read = !!a1 && a1.data.v === 1;
        r.matchWrite = await store.users.put(k, { v: 3 }, { ifMatch: a1.etag });
        r.staleWriteBlocked = !(await store.users.put(k, { v: 4 }, { ifMatch: a1.etag }));
        const a2 = await store.users.get(k); r.readAfterWrite = !!a2 && a2.data.v === 3;
        await store.lot.put(mk, 1, {}); r.list = (await store.lot.list("mT")).includes(mk);
        await store.lot.del(mk); r.delete = !(await store.lot.list("mT")).includes(mk);
        await store.users.del(k);
      } catch (e) { r.error = String(e && e.message || e); }
      const keys = Object.keys(r).filter((x) => x !== "error"), ok = !r.error && keys.every((x) => r[x] === true);
      return { ok, checks: r };
    }
    if (body.action === "settings") {
      const ig = String(body.ig || "").trim().replace(/^@+/, "").toLowerCase();
      if (ig && !NICK_RE.test(ig)) throw new HttpError(400, "Instagram nomi noto’g’ri");
      await cas(store.meta, "config", (c) => { c.ig = ig; return c; }, () => ({})); return { ok: true, ig };
    }
    if (body.action === "level") {
      const nick = normNick(body.nick), lv = body.level | 0; if (!nick) throw new HttpError(400, "Nik noto’g’ri");
      if (lv < 0 || lv > 2) throw new HttpError(400, "Daraja 0, 1 yoki 2 bo’lishi kerak");
      if (!(await store.users.get(nick))) throw new HttpError(404, "Bu nik bazada yo’q");
      let p = null, car = null;
      await cas(store.users, nick, (d) => { d.lv = lv; p = d.p; car = d.car || null; return d; }, () => ({}));
      if (p != null) await setSlot(p, [nick, car ? carStr(car) : "", lv]);
      return { ok: true, nick, level: lv };
    }
    if (body.action === "featured") {
      if (!body.nick) { await store.meta.put("featured", {}, {}); return { ok: true, featured: null }; }
      const nick = normNick(body.nick); if (!nick) throw new HttpError(400, "Nik noto’g’ri");
      const rec = await store.users.get(nick); if (!rec || rec.data.p == null) throw new HttpError(404, "Bu nik turargohda yo’q");
      await store.meta.put("featured", { nick, p: rec.data.p, t: now() }, {});
      return { ok: true, featured: { nick, p: rec.data.p } };
    }
    if (body.action === "stats") return { ...(await computeStats()), config: await config() };
    if (body.action === "export") { const cars = []; await allChunks((e) => cars.push({ nick: e[0], car: e[1] || null })); return { count: cars.length, cars }; }
    throw new HttpError(400, "Noma’lum amal");
  }

  async function handle(req) {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)\/?/, "");
      let body = {};
      if (req.method === "POST") {
        const txt = await req.text(); if (txt.length > 200000) throw new HttpError(413, "So’rov katta");
        try { body = JSON.parse(txt || "{}"); } catch { throw new HttpError(400, "So’rov noto’g’ri"); }
      }
      if (path === "ping") return json({ ok: true });
      if (req.method === "GET") {
        if (path === "car") { const nick = normNick(url.searchParams.get("nick")); if (!nick) throw new HttpError(400, "Nik noto’g’ri"); return json(await status(nick)); }
        if (path === "lotmeta") return json(await lotMeta(), 200, cdn(15));
        if (path === "lot") return json(await lotChunk(+url.searchParams.get("c") || 0), 200, cdn(20));
        if (path === "stats") return json(await stats(), 200, cdn(60));
      }
      if (req.method === "POST") {
        if (path === "admin") return json(await admin(body, req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?"));
        const nick = normNick(body.nick); if (!nick) throw new HttpError(400, "Nik noto’g’ri");
        if (path === "setpin") return json(await setPin(nick, body.pin, body.car));
        if (path === "check") { const rec = await checkPin(nick, body.pin); return json({ ok: true, car: rec.data.car || null, p: rec.data.p ?? null }); }
        if (path === "save") return json(await save(nick, body.pin, body.car));
      }
      throw new HttpError(404, "Topilmadi");
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Server xatosi. Birozdan keyin qayta urinib ko’ring" }, 500);
    }
  }
  return { handle, computeStats };
}

// Netlify Blobs (bepul tarifda ham bor). Uchta ombor: users (har bir nik), lot (200 talik turargoh bo‘laklari), meta.

const open = (name) => getStore({ name, consistency: "strong" });
function area(name) {
  return {
    async get(key) { const r = await open(name).getWithMetadata(key, { type: "json" }); return r && r.data != null ? { data: r.data, etag: r.etag } : null; },
    async put(key, data, cond = {}) {
      const opts = cond.ifNew ? { onlyIfNew: true } : cond.ifMatch ? { onlyIfMatch: cond.ifMatch } : {};
      const res = await open(name).setJSON(key, data, opts);
      return !(res && res.modified === false);
    },
    async list(prefix) { const out = []; for await (const pg of open(name).list({ prefix, paginate: true })) out.push(...pg.blobs.map((b) => b.key)); return out; },
    async del(key) { await open(name).delete(key); },
  };
}
function makeNetlifyStore() { return { users: area("users"), lot: area("lot"), meta: area("meta") }; }

const api = makeApi(makeNetlifyStore(), {
  ADMIN_KEY: Netlify.env.get("ADMIN_KEY"),
  SECRET_SALT: Netlify.env.get("SECRET_SALT"),
});
export default async (req) => api.handle(req);
export const config = {
  path: "/api/*",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 3000 }, // mobil operatorlarda ko‘p odam bitta IP orqali chiqadi
};
