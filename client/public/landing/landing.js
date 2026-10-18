// Shared behaviour for the landing pages. Each page sets <body data-page="start|home|learn">.
// All data from the board service is rendered with textContent, never as HTML.
(function () {
  const C = window.ML_CONFIG, API = window.MLApi;
  const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const page = document.body.dataset.page;
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };

  /* ---------- shared SVG: pin gradient, blur, tape shadow, logo ---------- */
  document.body.insertAdjacentHTML('afterbegin', `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
    <radialGradient id="ppGrad" cx=".5" cy=".5" r=".6" fx=".36" fy=".32"><stop offset="0" stop-color="#ffb3ae"/><stop offset=".45" stop-color="#e0453f"/><stop offset="1" stop-color="#9e2420"/></radialGradient>
    <filter id="ppBlur" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="1.1"/></filter>
    <filter id="ppTape" x="-5%" y="-20%" width="110%" height="150%"><feDropShadow dx="0" dy="1" stdDeviation=".6" flood-color="#2a1a0c" flood-opacity=".18"/></filter>
    <symbol id="ppLogo" viewBox="0 0 22 28"><path d="M11 15.5 L8.6 26.5" stroke="#9a9a9a" stroke-width="1.8" stroke-linecap="round"/><ellipse cx="11.4" cy="15.6" rx="4.4" ry="1.6" fill="#a8261f"/><circle cx="11" cy="8.5" r="7.5" fill="url(#ppGrad)"/><circle cx="8.4" cy="5.9" r="2" fill="#fff" opacity=".7"/></symbol>
  </defs></svg>`);
  $$('[data-repo]').forEach((a) => (a.href = C.repoUrl + (a.dataset.repo || '')));
  if (API.mock) document.body.prepend(el('div', { class: 'mockbar', text: 'Sample data: the board service is not connected.' }));

  /* ---------- toast ---------- */
  let toastT;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = el('div', { class: 'toast', role: 'status' }); document.body.append(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 4000);
  }

  /* ---------- log in: faked for the demo, it only asks for a display name ---------- */
  const userName = () => localStorage.getItem('ml-name') || '';
  function loginDialog(then) {
    let d = $('dialog.login');
    if (!d) {
      d = el('dialog', { class: 'login' },
        el('form', { method: 'dialog' },
          el('h2', { text: 'What should we call you?' }),
          el('div', { class: 'small', text: 'Your collaborators see this name on the board.' }),
          el('input', { name: 'name', autocomplete: 'name', required: true, maxlength: 60, placeholder: 'Your name' }),
          el('div', { class: 'row' }, el('button', { class: 'btn', value: 'cancel', formnovalidate: true, text: 'Cancel' }), el('button', { class: 'btn primary', value: 'ok', text: 'Continue' }))));
      document.body.append(d);
    }
    const input = $('input', d); input.value = userName();
    d.onclose = () => { if (d.returnValue === 'ok' && input.value.trim()) { localStorage.setItem('ml-name', input.value.trim()); then && then(); } };
    d.showModal();
  }
  $$('[data-login]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); loginDialog(() => (location.href = './home.html')); }));
  // signed in: the nav shows the name and a link to your boards instead of Log in / Sign up
  if (userName()) {
    $$('[data-guest]').forEach((n) => (n.hidden = true));
    $$('[data-user]').forEach((n) => { n.hidden = false; $$('[data-user-name]', n).forEach((s) => (s.textContent = userName())); $$('[data-user-initial]', n).forEach((s) => (s.textContent = userName().charAt(0).toUpperCase())); });
  }

  /* ---------- drawing helpers: the same marker loop and sagging string as the board ---------- */
  const hash = (s) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
  const tilt = (k) => ((hash(k) % 9) / 8 * 2 - 1) * 1.8;
  const rnd = (seed) => { let v = seed % 2147483647 || 1; return () => { v = (v * 16807) % 2147483647; return (v - 1) / 2147483646; }; };
  function loopPath(cx, cy, rx, ry, seed, grow = 0.07, sq = 1) {
    const R = rnd(seed + 3), p = [], N = 22, a0 = -2.5, f = (v) => Math.sign(v) * Math.pow(Math.abs(v), sq);
    for (let i = 0; i <= N; i++) { const t = a0 + (Math.PI * 2 + 0.55) * i / N, k = 1 + (i / N) * grow + (R() - 0.5) * 0.035; p.push([cx + f(Math.cos(t)) * rx * k, cy + f(Math.sin(t)) * ry * k]); }
    let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
      d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }
  function sag(A, B, k = 1) {
    const dx = B.x - A.x, dy = B.y - A.y, s = (6 + Math.abs(dx) * 0.08 + Math.abs(dy) * 0.02) * k, M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 + s };
    return `M${A.x.toFixed(1)} ${A.y.toFixed(1)} Q${M.x.toFixed(1)} ${M.y.toFixed(1)} ${B.x.toFixed(1)} ${B.y.toFixed(1)}`;
  }
  const pinSvg = (x, y, r) => `<circle cx="${(x + r * 0.22).toFixed(1)}" cy="${(y + r * 0.45).toFixed(1)}" r="${(r * 0.85).toFixed(1)}" fill="rgba(0,0,0,.26)" filter="url(#ppBlur)"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="url(#ppGrad)"/><circle cx="${(x - r * 0.3).toFixed(1)}" cy="${(y - r * 0.33).toFixed(1)}" r="${(r * 0.26).toFixed(1)}" fill="#fff" opacity=".7"/>`;

  /* small board pictures: saved = solid paper with a red pin; new = see-through, taped up, numbered */
  const LAYOUTS = {
    a: { w: 300, h: 150, cw: 70, ch: 30, cards: [{ id: 'a', x: 18, y: 22 }, { id: 'b', x: 118, y: 12 }, { id: 'c', x: 212, y: 30 }, { id: 'd', x: 52, y: 96 }, { id: 'n', x: 168, y: 94, kind: 'new', rank: 1 }],
      links: [['a', 'b'], ['b', 'c'], ['a', 'd'], ['d', 'n'], ['b', 'n'], ['c', 'n']] },
    b: { w: 300, h: 150, cw: 70, ch: 30, cards: [{ id: 'a', x: 26, y: 30 }, { id: 'b', x: 150, y: 18 }, { id: 'c', x: 206, y: 94 }, { id: 'n', x: 70, y: 98, kind: 'new', rank: 1 }],
      links: [['a', 'b'], ['b', 'c'], ['a', 'n'], ['c', 'n']] },
    hero: { w: 640, h: 176, cw: 104, ch: 40, cards: [{ id: 'a', x: 44, y: 32 }, { id: 'b', x: 262, y: 20 }, { id: 'c', x: 486, y: 40 }, { id: 'n1', x: 150, y: 114, kind: 'new', rank: 1 }, { id: 'n2', x: 380, y: 118, kind: 'new', rank: 2 }],
      links: [['a', 'b'], ['b', 'c'], ['a', 'n1'], ['b', 'n1'], ['b', 'n2'], ['c', 'n2']] },
  };
  function scene(layout, key, withNew = true) {
    const S = LAYOUTS[layout], CW = S.cw, CH = S.ch, k = CH / 70;
    const cards = S.cards.filter((c) => withNew || c.kind !== 'new');
    const by = (id) => cards.find((c) => c.id === id), top = (c) => ({ x: c.x + CW / 2, y: c.y + 4 });
    const sw = layout === 'hero' ? 1.9 : 1.5, pr = layout === 'hero' ? 6 : 4.6;
    const rot = (c) => `rotate(${tilt(key + c.id).toFixed(2)} ${c.x + CW / 2} ${c.y + CH / 2})`;
    const bars = (c, L) => `<rect x="${L}" y="${c.y + CH * 0.3}" width="${CW * 0.5}" height="${CH * 0.13}" rx="1" fill="rgba(43,43,43,.72)"/><rect x="${L}" y="${c.y + CH * 0.58}" width="${CW * 0.72}" height="${CH * 0.09}" rx="1" fill="rgba(43,43,43,.28)"/>`;
    let s = `<svg viewBox="0 0 ${S.w} ${S.h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">`;
    cards.forEach((c) => {
      const L = c.x + CW * 0.09, mx = c.x + CW / 2;
      s += `<g transform="${rot(c)}">`;
      if (c.kind === 'new') {
        const tw = CW / 3, th = Math.max(5, 16 * k);
        s += `<rect x="${c.x + 0.5}" y="${c.y + 0.5}" width="${CW - 1}" height="${CH - 1}" rx="2" fill="rgba(255,255,255,.4)" stroke="rgba(34,29,24,.16)" stroke-width="1"/>${bars(c, L)}`;
        s += `<rect class="pp-tapebit" x="${(mx - tw / 2).toFixed(1)}" y="${(c.y - th / 2).toFixed(1)}" width="${tw.toFixed(1)}" height="${th.toFixed(1)}" transform="rotate(-3 ${mx} ${c.y})" filter="url(#ppTape)"/>`;
      } else {
        s += `<rect x="${c.x + 1}" y="${c.y + 3}" width="${CW}" height="${CH}" rx="2" fill="rgba(0,0,0,.2)" filter="url(#ppBlur)"/><rect x="${c.x}" y="${c.y}" width="${CW}" height="${CH}" rx="2" fill="#fff"/>${bars(c, L)}`;
      }
      s += '</g>';
    });
    S.links.filter(([a, b]) => by(a) && by(b)).forEach(([a, b]) => {
      const d = sag(top(by(a)), top(by(b)), 0.8);
      s += `<path d="${d}" fill="none" stroke="rgba(0,0,0,.13)" stroke-width="${sw + 0.5}" transform="translate(.8 1.6)" filter="url(#ppBlur)"/><path d="${d}" fill="none" stroke="#c2322f" stroke-width="${sw}" stroke-linecap="round"/>`;
    });
    cards.forEach((c) => { const p = top(c); s += c.kind === 'new' ? `<circle cx="${p.x}" cy="${p.y}" r="${(sw * 1.1).toFixed(1)}" fill="#c2322f"/>` : pinSvg(p.x, p.y, pr); });
    cards.filter((c) => c.kind === 'new').forEach((c) => {
      const cx = c.x + 2 * k, cy = c.y + k;
      s += `<g class="pp-rank" transform="${rot(c)}"><path d="${loopPath(cx, cy, 14 * k, 13 * k, hash(key + c.id) + c.rank)}" stroke-width="${Math.max(1.1, 2.2 * k).toFixed(2)}"/><text x="${cx.toFixed(1)}" y="${(cy + 6.5 * k).toFixed(1)}" text-anchor="middle" font-size="${(18 * k).toFixed(1)}">${c.rank}</text></g>`;
    });
    return s + '</svg>';
  }
  $$('[data-scene]').forEach((n) => (n.innerHTML = scene(n.dataset.scene, n.dataset.scene)));

  /* ======================= START ======================= */
  function initStart() {
    const ta = $('#ta'), seedsEl = $('#seeds'), send = $('#send'), hint = $('#hint'), file = $('#file');
    const papers = []; // {label, doi?} | {label, pmid?} | {label, file}
    const TILT = [-1.2, 0.8, -0.4, 1.1, -0.9, 0.5];
    const EXAMPLE = {
      question: 'Which single-cell methods help study melanoma immune cells?',
      seeds: [
        { label: 'Tirosh 2016 · Science', doi: '10.1126/science.aad0501' },
        { label: 'Sade-Feldman 2018 · Cell', doi: '10.1016/j.cell.2018.10.038' },
        { label: 'Oliveira 2021 · Nature', doi: '10.1038/s41586-021-03704-y' },
        { label: 'Oliveira 2022 · Nature', doi: '10.1038/s41586-022-04682-5' },
        { label: 'Smalley 2021 · Clin Cancer Res', doi: '10.1158/1078-0432.CCR-21-1694' },
      ],
    };
    let busy = false;
    const caseNow = () => { const t = ta.value.trim().length > 0, p = papers.length > 0; return t && p ? 'both' : t ? 'text' : p ? 'papers' : 'empty'; };
    function setHint(text, err) { hint.textContent = text; hint.classList.toggle('err', !!err); }
    function render() {
      seedsEl.replaceChildren(...papers.map((p, i) => {
        const x = el('button', { class: 'x', type: 'button', title: 'Remove', 'aria-label': `Remove ${p.label}`, text: '×' });
        x.addEventListener('click', () => { papers.splice(i, 1); render(); });
        const chip = el('span', { class: 'chip pp-card', style: `--r:${TILT[i % TILT.length]}deg` }, el('i', { class: 'pp-pin', 'aria-hidden': 'true' }), p.label, x);
        return chip;
      }));
      const c = caseNow(), n = papers.length;
      if (!busy) setHint({
        empty: 'A question, a rough description of your topic, or a few papers. Any of these works; together works best.',
        text: 'We’ll find papers for this, then you pick a few to start from.',
        papers: `We’ll work out what links ${n === 1 ? 'this paper' : 'these ' + n + ' papers'} and look for more. You can sharpen the question on the board.`,
        both: `We’ll search around your ${n === 1 ? 'paper' : n + ' papers'} for this question.`,
      }[c]);
      send.disabled = busy || c === 'empty';
    }
    // pasted DOIs and PubMed links become paper chips
    const ID_RE = /\b(10\.\d{4,9}\/[^\s,;<>"]+[^\s,;.)<>"])|(?:https?:\/\/)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?|\bPMID:?\s*(\d{6,9})\b/gi;
    ta.addEventListener('input', () => {
      const found = [];
      const rest = ta.value.replace(ID_RE, (m, doi, pm1, pm2) => { found.push(doi ? { label: `DOI ${doi}`, doi } : { label: `PMID ${pm1 || pm2}`, pmid: pm1 || pm2 }); return ''; }).replace(/[ \t]{2,}/g, ' ');
      if (found.length) {
        const have = new Set(papers.map((p) => p.doi || p.pmid));
        found.filter((p) => !have.has(p.doi || p.pmid)).forEach((p) => papers.push(p));
        ta.value = rest.trimStart();
        toast(`${found.length} paper${found.length > 1 ? 's' : ''} added from what you pasted.`);
      }
      render();
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
    $('#addPapers').addEventListener('click', () => file.click());
    file.addEventListener('change', () => { [...file.files].forEach((f) => papers.push({ label: f.name, file: f })); file.value = ''; render(); });
    $$('[data-example]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.example === 'melanoma') { ta.value = EXAMPLE.question; papers.splice(0, papers.length, ...EXAMPLE.seeds); }
      else { ta.value = b.textContent.trim(); papers.length = 0; }
      render(); ta.focus();
    }));
    send.addEventListener('click', submit);

    async function submit() {
      if (busy || caseNow() === 'empty') return;
      const question = ta.value.trim();
      busy = true; render();
      try {
        setHint('Creating your board…');
        const board = await API.createBoard({ title: question ? question.slice(0, 80) : 'Untitled board', question, context: '' });
        for (let i = 0; i < papers.length; i++) {
          setHint(`Adding your papers… ${i + 1} of ${papers.length}`);
          const p = papers[i];
          await API.addSeed(board.id, p.file ? { file: p.file } : p.doi ? { doi: p.doi } : { pmid: p.pmid });
        }
        setHint('Starting the agent…');
        await API.startRun(board.id, 'onboarding');
        if (API.mock) { busy = false; render(); toast(`Sample data: board ${board.id} created. With the board service connected, it opens now.`); return; }
        location.href = C.boardUrl(board.id);
      } catch (e) {
        busy = false; render();
        setHint(`${e.message || 'Something went wrong.'} Your question and papers are still here; try again.`, true);
      }
    }

    // the demo board link only shows once a board is configured
    const demo = $('#demoLink');
    if (C.demoBoardUrl) { $('a', demo).href = C.demoBoardUrl; demo.hidden = false; }

    // red marker circle around "missing", drawn once, then a string down to the box
    let drawn = false;
    function drawArt() {
      const sec = $('.start'), word = $('#missing'), box = $('.onebox'), svg = $('#overlay');
      const S = sec.getBoundingClientRect(), W = word.getBoundingClientRect(), B = box.getBoundingClientRect();
      const cx = W.left - S.left + W.width / 2 + 4, cy = W.top - S.top + W.height / 2 + 3, rx = W.width / 2 + 5, ry = W.height / 2 + 4;
      const anim = !drawn; drawn = true;
      const a = 0.72, from = { x: cx + Math.cos(a) * rx * 1.04, y: cy + Math.sin(a) * ry * 1.04 }, to = { x: B.right - S.left - 54, y: B.top - S.top + 1 };
      const str = sag(from, to, 0.45);
      svg.innerHTML = `<path class="pp-loop${anim ? ' pp-draw' : ''}" pathLength="1" d="${loopPath(cx, cy, rx, ry, 11, 0.02, 0.72)}"/>` +
        `<path class="pp-shadow${anim ? ' pp-fadein' : ''}" d="${str}" transform="translate(.8 1.6)"/>` +
        `<path class="pp-string${anim ? ' pp-draw late' : ''}" pathLength="1" d="${str}"/>` +
        `<g class="${anim ? 'pp-fadein' : ''}">${pinSvg(to.x, to.y, 5)}</g>`;
    }
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => requestAnimationFrame(drawArt));
    addEventListener('resize', () => requestAnimationFrame(drawArt));
    render();
  }

  /* ======================= HOME ======================= */
  async function initHome() {
    const name = userName();
    $('#welcome').textContent = name ? `Welcome back, ${name}` : 'Welcome back';
    const list = $('#boards'), lead = $('#lead'), all = $('#catchAll');
    const newCard = el('a', { class: 'newcard', href: './index.html', text: '+ New board' });
    list.replaceChildren(el('div', { class: 'state', text: 'Loading your boards…' }));
    let boards;
    try { boards = (await API.listBoards()) || []; }
    catch (e) { list.replaceChildren(el('div', { class: 'state err', text: `Couldn’t load your boards. ${e.message}` }), newCard); lead.textContent = ''; return; }
    const memberNames = (b) => (b.members || []).map((m) => (typeof m === 'string' ? m : m.displayName)).filter((m) => m && m !== name);
    const totalNew = boards.reduce((s, b) => s + (b.newCount || 0), 0);
    lead.textContent = boards.length === 0 ? 'Start your first board from a question or a few papers.'
      : totalNew ? `The agent found ${totalNew} new paper${totalNew === 1 ? '' : 's'} on your boards since your last visit.` : 'Nothing new since your last visit.';
    const withNew = boards.filter((b) => b.newCount > 0).sort((a, b) => b.newCount - a.newCount);
    if (withNew.length) { all.hidden = false; all.href = `${C.boardUrl(withNew[0].id)}?${C.tourQuery}`; }
    list.replaceChildren(...boards.map((b) => {
      const url = C.boardUrl(b.id), others = memberNames(b);
      const meta = [b.seedCount != null && `${b.seedCount} seeds`, b.paperCount != null && `${b.paperCount} papers`, others.length ? `with ${others.join(', ')}` : 'only you'].filter(Boolean).join(' · ');
      const thumb = el('a', { class: 'pp-thumb pp-surface', href: url, 'aria-hidden': 'true', tabindex: '-1' });
      thumb.innerHTML = scene(hash(b.id) % 2 ? 'a' : 'b', b.id, b.newCount > 0); // decorative, built from numbers only
      return el('div', { class: 'box bcard' },
        thumb,
        el('a', { class: 't', href: url, text: b.title || 'Untitled board' }),
        el('div', { class: 'small', text: meta }),
        el('div', { class: 'row' },
          b.newCount > 0 ? el('span', { class: 'badge', text: `${b.newCount} new` }) : null,
          el('span', { style: 'flex:1' }),
          el('a', { class: 'btn sm', href: b.newCount > 0 ? `${url}?${C.tourQuery}` : url, text: b.newCount > 0 ? 'Catch me up' : 'Open' })));
    }), newCard);
  }

  /* ======================= HOW IT WORKS ======================= */
  function initLearn() {
    const v = C.demoVideoUrl;
    if (!v) { $$('[data-video]').forEach((n) => (n.hidden = true)); return; }
    const slot = $('#videoSlot');
    slot.replaceChildren(/\.(mp4|webm)(\?|$)/i.test(v)
      ? el('video', { class: 'video', src: v, controls: true, preload: 'metadata' })
      : el('iframe', { class: 'video', src: v, title: 'Missing Links: 2-minute demo', allow: 'fullscreen; picture-in-picture', allowfullscreen: true }));
  }

  ({ start: initStart, home: initHome, learn: initLearn })[page]?.();
})();
