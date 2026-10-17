/*
 * web-site-check: ブラウザ内で実行する判定処理
 *
 * TypeScriptの変換を通さずに、そのままページへ注入する（page.evaluate に文字列で渡す）。
 * すべての関数は window.__wsc に生やし、結果はJSONにできる値だけを返す。
 */
(() => {
  if (window.__wsc) return;
  const W = {};

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'TITLE', 'HEAD', 'META', 'LINK']);
  const cs = (el, pseudo) => getComputedStyle(el, pseudo || null);

  const short = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  /** 要素の説明（タグ#id.class「テキスト」） */
  const desc = (el) => {
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) d += '.' + cls.join('.');
    const t = short(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('alt') || '', 30);
    return t ? d + '「' + t + '」' : d;
  };

  const ownText = (el) =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

  const effectiveOpacity = (el) => {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(cs(e).opacity);
    return o;
  };

  /** 画面に描画されているか（透明・非表示・サイズ0を除く） */
  const visible = (el) => {
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return effectiveOpacity(el) > 0.05;
  };

  /** 本文テキストを直接持つ要素 */
  const textEls = (limit) => {
    const out = [];
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && out.length < (limit || 2000); i++) {
      const el = all[i];
      if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el.closest('svg, script, style, noscript, template')) continue;
      if (ownText(el).length === 0) continue;
      out.push(el);
    }
    return out;
  };

  const allIndex = () => Array.from(document.body ? document.body.getElementsByTagName('*') : []);

  /** CSSOMのルールを再帰的にたどる。読めない（別オリジンの）シートは数だけ返す */
  const eachRule = (fn) => {
    let blocked = 0;
    const walk = (rules, media) => {
      for (const r of Array.from(rules)) {
        if (r.cssRules && (r.type === 4 || r.type === 12 || r.constructor.name === 'CSSLayerBlockRule' || r.constructor.name === 'CSSContainerRule')) {
          fn(r, media);
          walk(r.cssRules, r.conditionText || (r.media && r.media.mediaText) || media);
        } else fn(r, media);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        blocked++;
        continue;
      }
      if (rules) walk(rules, sheet.media && sheet.media.mediaText);
    }
    return blocked;
  };

  // ---------- レイアウト ----------
  W.overflow = () => {
    const root = document.documentElement;
    const vw = root.clientWidth;
    const sw = Math.max(root.scrollWidth, document.body ? document.body.scrollWidth : 0);
    const hiddenX = ['hidden', 'clip'].includes(cs(root).overflowX) || (document.body && ['hidden', 'clip'].includes(cs(document.body).overflowX));
    const offenders = [];
    for (const el of allIndex()) {
      if (offenders.length >= 30) break;
      if (SKIP_TAGS.has(el.tagName.toUpperCase())) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.right <= vw + 1) continue;
      if (!visible(el)) continue;
      // 横スクロールする親（カルーセルなど）の中なら対象外
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body && p !== root; p = p.parentElement) {
        const ox = cs(p).overflowX;
        if (ox === 'hidden' || ox === 'auto' || ox === 'scroll' || ox === 'clip') {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      // 親もはみ出しているなら、親だけを数える
      const parent = el.parentElement;
      if (parent && parent.getBoundingClientRect().right > vw + 1 && offenders.some((o) => o.el === parent)) continue;
      offenders.push({ el, over: Math.round(r.right - vw) });
    }
    return { vw, sw, overflow: sw > vw + 1, hiddenX: !!hiddenX, offenders: offenders.slice(0, 5).map((o) => desc(o.el) + '（+' + o.over + 'px）') };
  };

  W.clipped = () => {
    const out = [];
    for (const el of allIndex()) {
      if (out.length >= 10) break;
      if (SKIP_TAGS.has(el.tagName.toUpperCase())) continue;
      const s = cs(el);
      const ox = s.overflowX;
      const oy = s.overflowY;
      const hides = (v) => v === 'hidden' || v === 'clip';
      if (!hides(ox) && !hides(oy)) continue;
      if (s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none')) continue;
      if (!(el.innerText || '').trim()) continue;
      if (!visible(el)) continue;
      const overY = hides(oy) && el.scrollHeight > el.clientHeight + 2;
      const overX = hides(ox) && el.scrollWidth > el.clientWidth + 2;
      if (!overY && !overX) continue;
      // 子要素がテキストを持たない装飾（画像のトリミングなど）は除外
      if (!textEls(50).some((t) => el.contains(t))) continue;
      out.push(desc(el) + '（' + (overY ? '高さ' : '幅') + 'が足りない）');
    }
    return out;
  };

  const SUPP_SEL = 'small, figcaption, footer, caption, sup, sub, rt, [class*="note"], [class*="caption"], [class*="copy"], [class*="annotation"], [class*="cap"]';
  const BODY_TAGS = new Set(['P', 'LI', 'DD', 'DT', 'TD', 'TH', 'BLOCKQUOTE']);

  W.fonts = () => {
    const small = [];
    let total = 0;
    let under12 = 0;
    for (const el of textEls(3000)) {
      if (!visible(el)) continue;
      const fs = parseFloat(cs(el).fontSize);
      const n = ownText(el).length;
      total += n;
      if (fs < 12) under12 += n;
      const supp = !!el.closest(SUPP_SEL);
      const block = el.closest('p, li, dd, dt, td, th, blockquote') || el;
      const kind = supp ? 'supp' : BODY_TAGS.has(block.tagName) || BODY_TAGS.has(el.tagName) ? 'body' : 'other';
      if (fs <= 10 || (fs < 14 && kind === 'body')) small.push({ desc: desc(el), fs: Math.round(fs * 10) / 10, kind });
    }
    return { small: small.slice(0, 40), total, under12 };
  };

  W.vh100 = () => {
    const out = [];
    eachRule((r) => {
      if (!r.style || !r.selectorText) return;
      for (const p of ['height', 'min-height', 'max-height']) {
        const v = r.style.getPropertyValue(p);
        if (/(^|[^.\d])100vh/.test(v)) out.push(r.selectorText + ' { ' + p + ': ' + v + ' }');
      }
    });
    for (const el of document.querySelectorAll('[style*="100vh"]')) out.push(desc(el) + '（style属性）');
    return Array.from(new Set(out)).slice(0, 10);
  };

  W.tapTargets = () => {
    const out = [];
    const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], summary';
    const targets = Array.from(document.querySelectorAll(sel)).filter(visible);
    const rects = targets.map((t) => t.getBoundingClientRect());
    const distToRect = (x, y, r) => {
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      return Math.hypot(dx, dy);
    };
    for (const el of targets) {
      if (out.length >= 15) break;
      const s = cs(el);
      // 文中のリンクは対象外（WCAG 2.5.8 の例外）
      if (s.display === 'inline' && el.parentElement && ownText(el.parentElement).length > 0) continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        const lab = el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'));
        if (lab && visible(lab)) continue;
      }
      const r = el.getBoundingClientRect();
      if (Math.min(r.width, r.height) >= 24) continue;
      // 例外：中心から半径12pxの円が、ほかのタップ対象と重ならなければ合格（WCAG 2.5.8 の間隔の例外）
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      const crowded = targets.some((o, k) => {
        if (o === el || o.contains(el) || el.contains(o)) return false;
        const orc = rects[k];
        const small = Math.min(orc.width, orc.height) < 24;
        if (small) return Math.hypot((orc.left + orc.right) / 2 - cx, (orc.top + orc.bottom) / 2 - cy) < 24;
        return distToRect(cx, cy, orc) < 12;
      });
      if (crowded) out.push(desc(el) + '（' + Math.round(r.width) + '×' + Math.round(r.height) + 'px、近くに別のリンク・ボタンがある）');
    }
    return out;
  };

  W.fixedTop = () => {
    let bottom = 0;
    const els = [];
    for (const el of allIndex()) {
      const s = cs(el);
      if (s.position !== 'fixed' && s.position !== 'sticky') continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top > 1 || r.width < window.innerWidth * 0.5) continue;
      if (r.bottom > bottom) bottom = r.bottom;
      els.push(desc(el));
    }
    return { ratio: bottom / window.innerHeight, px: Math.round(bottom), els: els.slice(0, 3) };
  };

  /** 固定ヘッダーが見出し・本文を覆っていないか（スクロール位置は先頭） */
  W.headerCovers = () => {
    const headers = [];
    for (const el of allIndex()) {
      const s = cs(el);
      if (s.position !== 'fixed' && s.position !== 'sticky') continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top > 1 || r.width < window.innerWidth * 0.5 || r.height > window.innerHeight * 0.6) continue;
      headers.push(el);
    }
    const res = { covered: [], anchors: [] };
    if (headers.length === 0) return res;
    const bottom = Math.max(...headers.map((h) => h.getBoundingClientRect().bottom));
    const cands = Array.from(document.querySelectorAll('h1, main h2, main p, main li, [role="main"] h2')).slice(0, 30);
    for (const el of cands) {
      if (res.covered.length >= 3) break;
      if (headers.some((h) => h.contains(el)) || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top >= bottom || r.bottom <= 0) continue;
      const x = Math.min(Math.max(r.left + 5, 1), window.innerWidth - 2);
      const y = Math.max(r.top + Math.min(r.height / 2, 10), 1);
      const hit = document.elementFromPoint(x, y);
      if (hit && headers.some((h) => h === hit || h.contains(hit))) res.covered.push(desc(el) + '（ヘッダーの高さ' + Math.round(bottom) + 'px）');
    }
    const pad = parseFloat(cs(document.documentElement).scrollPaddingTop) || 0;
    if (pad < bottom - 5) {
      for (const a of document.querySelectorAll('a[href^="#"]')) {
        if (res.anchors.length >= 3) break;
        const id = decodeURIComponent((a.getAttribute('href') || '').slice(1));
        if (!id) continue;
        const t = document.getElementById(id);
        if (!t || headers.some((h) => h.contains(t))) continue;
        if ((parseFloat(cs(t).scrollMarginTop) || 0) + pad >= bottom - 5) continue;
        res.anchors.push('#' + id + '（' + desc(t) + '）');
      }
    }
    return res;
  };

  /** :focus の outline を消していて、:focus-visible での代わりの指定がない CSS */
  W.focusOutlineRules = () => {
    const removed = [];
    let visibleRule = false;
    eachRule((r) => {
      if (!r.style || !r.selectorText) return;
      const sel = r.selectorText;
      const oStyle = r.style.getPropertyValue('outline-style');
      const o = r.style.getPropertyValue('outline');
      const none = oStyle === 'none' || /^(none|0(px)?)\b/.test(o) || r.style.getPropertyValue('outline-width') === '0px';
      if (/:focus-visible/.test(sel) && !/:not\(:focus-visible\)/.test(sel) && !none) visibleRule = true;
      if (none && /:focus\b/.test(sel) && !/:focus-visible/.test(sel)) removed.push(sel + ' { outline: none }');
    });
    return visibleRule ? [] : Array.from(new Set(removed)).slice(0, 5);
  };

  // ---------- 色 ----------
  const parseColor = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const blend = (top, bottom) => {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  };
  const canvas = () => {
    const scheme = cs(document.documentElement).colorScheme || '';
    const dark = /dark/.test(scheme) && matchMedia('(prefers-color-scheme: dark)').matches && !/light/.test(scheme.replace('dark', ''));
    return dark ? [18, 18, 18, 1] : [255, 255, 255, 1];
  };
  /** 背景色を親へたどって決める。背景画像やグラデーションに当たったら判定しない（null） */
  const effectiveBg = (el) => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const s = cs(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = parseColor(s.backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    let bg = canvas();
    for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
    return bg;
  };

  W.contrast = () => {
    const all = allIndex();
    const out = [];
    for (const el of textEls(800)) {
      if (!visible(el)) continue;
      const fg0 = parseColor(cs(el).color);
      const bg = effectiveBg(el);
      if (!fg0 || !bg) continue;
      const fg = fg0[3] < 1 ? blend(fg0, bg) : fg0;
      const l1 = lum(fg);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      out.push({ i: all.indexOf(el), desc: desc(el), ratio: Math.round(ratio * 100) / 100, fg: cs(el).color, bg: 'rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ')' });
    }
    return out;
  };

  W.colorDecl = () => {
    let color = false;
    let background = false;
    let darkMedia = false;
    const blocked = eachRule((r, media) => {
      if (r.conditionText && /prefers-color-scheme/.test(r.conditionText)) darkMedia = true;
      if (r.media && /prefers-color-scheme/.test(r.media.mediaText || '')) darkMedia = true;
      if (!r.style || !r.selectorText) return;
      if (media && /prefers-color-scheme|print/.test(media)) return;
      const parts = r.selectorText.split(',').map((s) => s.trim());
      if (!parts.some((p) => /^(html|body|:root)$/.test(p))) return;
      if (r.style.getPropertyValue('color')) color = true;
      if (r.style.getPropertyValue('background-color') || r.style.getPropertyValue('background')) background = true;
    });
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      if (el.style.color) color = true;
      if (el.style.backgroundColor || el.style.background) background = true;
    }
    const meta = document.querySelector('meta[name="color-scheme"]');
    return {
      color,
      background,
      darkMedia,
      colorScheme: (cs(document.documentElement).colorScheme || '') + (meta ? ' meta:' + meta.getAttribute('content') : ''),
      blocked,
    };
  };

  W.fontSample = () => {
    const all = allIndex();
    return textEls(400)
      .filter(visible)
      .map((el) => ({ i: all.indexOf(el), fs: parseFloat(cs(el).fontSize) }));
  };

  // ---------- 表示されないコンテンツ ----------
  W.hiddenContent = () => {
    let total = 0;
    let hidden = 0;
    const items = [];
    for (const el of textEls(2000)) {
      if (el.closest('[hidden], [aria-hidden="true"], dialog:not([open]), details:not([open])')) continue;
      const s = cs(el);
      if (s.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // 画面外へ追い出したメニュー（ドロワー）や読み上げ専用テキストは除外
      if (r.right < 0 || r.left > window.innerWidth + 5 || (r.width <= 2 && r.height <= 2)) continue;
      let fixedAncestor = false;
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        if (cs(e).position === 'fixed') {
          fixedAncestor = true;
          break;
        }
      }
      if (fixedAncestor) continue;
      const n = ownText(el).length;
      total += n;
      const op = effectiveOpacity(el);
      if (op <= 0.05 || s.visibility === 'hidden') {
        hidden += n;
        if (n >= 8 && items.length < 8) items.push(desc(el));
      }
    }
    return { total, hidden, items };
  };

  W.overlays = () => {
    const vwA = window.innerWidth * window.innerHeight;
    const out = [];
    for (const el of allIndex()) {
      if (out.length >= 3) break;
      const s = cs(el);
      if (s.position !== 'fixed' && s.position !== 'absolute') continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      if ((w * h) / vwA < 0.7) continue;
      if (el.tagName === 'MAIN' || el.querySelector('main, h1')) continue;
      const bgc = parseColor(s.backgroundColor);
      if ((!bgc || bgc[3] < 0.5) && s.backgroundImage === 'none') continue;
      out.push(desc(el));
    }
    return out;
  };

  // ---------- 読み上げ ----------
  const SYMBOL_RUN = /([★☆●○◎◆◇■□▲△▼▽♪♫✓✔✕✖])\1|[★☆]{2,}|(^|\s)[▶►▷→⇒≫»＞]{1,2}\s?|>>/;
  // ©や★のように通常は文字として表示される記号は除き、絵文字として表示されるものだけを対象にする
  const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u;
  W.a11yExtra = () => {
    const res = { symbols: [], emoji: [], sameText: [], langMixed: [], ariaHiddenFocusable: [], visualOrder: [], tabindex: [] };
    const pageLang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
    for (const el of textEls(3000)) {
      if (el.closest('[aria-hidden="true"], [role="img"][aria-label]')) continue;
      const t = ownText(el);
      if (SYMBOL_RUN.test(t) && res.symbols.length < 6) res.symbols.push(desc(el));
      if (EMOJI.test(t) && res.emoji.length < 6) res.emoji.push(desc(el));
    }
    // 同じ文言で行き先が違うリンク
    const map = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      if (!visible(a) || a.getAttribute('aria-label') || a.getAttribute('aria-labelledby')) continue;
      const t = short(a.innerText || '', 40);
      if (!t) continue;
      const href = a.href.replace(/#.*$/, '');
      if (!map.has(t)) map.set(t, new Set());
      map.get(t).add(href);
    }
    for (const [t, set] of map) if (set.size > 1 && res.sameText.length < 6) res.sameText.push('「' + t + '」→ ' + set.size + '種類のリンク先');
    // 日本語ページ内の英文
    if (/^ja/.test(pageLang)) {
      for (const el of document.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, td')) {
        if (res.langMixed.length >= 5) break;
        const t = (el.innerText || '').trim();
        if (t.length < 40) continue;
        const latin = (t.match(/[A-Za-z]/g) || []).length;
        if (latin / t.replace(/\s/g, '').length < 0.8) continue;
        const langEl = el.closest('[lang]');
        if (langEl && /^ja/i.test(langEl.getAttribute('lang') || '') && visible(el)) res.langMixed.push(desc(el));
      }
    }
    // aria-hidden の中のフォーカスできる要素
    for (const el of document.querySelectorAll('[aria-hidden="true"] a[href], [aria-hidden="true"] button, [aria-hidden="true"] input, [aria-hidden="true"] select, [aria-hidden="true"] textarea, [aria-hidden="true"] [tabindex]')) {
      if (res.ariaHiddenFocusable.length >= 5) break;
      if (el.getAttribute('tabindex') === '-1' || el.disabled || !visible(el)) continue;
      res.ariaHiddenFocusable.push(desc(el));
    }
    // 見た目の順番と読み上げ順のズレ
    for (const el of allIndex()) {
      if (res.visualOrder.length >= 5) break;
      const s = cs(el);
      const rev = /reverse/.test(s.flexDirection) && (s.display.includes('flex'));
      const ord = s.order && s.order !== '0';
      if (!rev && !ord) continue;
      const host = rev ? el : el.parentElement;
      if (!host || !host.querySelector('a[href], button, h1, h2, h3, p')) continue;
      if (!visible(el)) continue;
      res.visualOrder.push(desc(host) + (rev ? '（flex-direction: ' + s.flexDirection + '）' : '（子要素に order: ' + s.order + '）'));
    }
    for (const el of document.querySelectorAll('[tabindex]')) {
      if (Number(el.getAttribute('tabindex')) > 0 && res.tabindex.length < 5) res.tabindex.push(desc(el) + '（tabindex="' + el.getAttribute('tabindex') + '"）');
    }
    res.visualOrder = Array.from(new Set(res.visualOrder));
    return res;
  };

  // ---------- キーボード・ホバー ----------
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const focusSnap = (el) => {
    const s = cs(el);
    return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|');
  };
  W.markFocusables = () => {
    const list = [];
    let i = 0;
    for (const el of document.querySelectorAll(FOCUSABLE)) {
      if (!visible(el) || el.closest('[inert], [aria-hidden="true"]')) continue;
      el.setAttribute('data-wsc-f', String(i));
      list.push({ i, desc: desc(el), snap: focusSnap(el) });
      i++;
    }
    return list;
  };
  W.active = () => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const s = cs(el);
    const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
    return { f: el.getAttribute('data-wsc-f'), desc: desc(el), snap: focusSnap(el), outline, href: el.getAttribute('href') || '' };
  };
  const hoverSnapOf = (el) => {
    const parts = [];
    const props = ['color', 'backgroundColor', 'opacity', 'textDecorationLine', 'textDecorationColor', 'transform', 'boxShadow', 'borderColor', 'filter', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'letterSpacing', 'fontWeight'];
    const nodes = [el, ...Array.from(el.querySelectorAll('*')).slice(0, 15)];
    for (const n of nodes) {
      for (const pseudo of [null, '::before', '::after']) {
        const s = cs(n, pseudo);
        if (pseudo && (s.content === 'none' || s.content === 'normal')) continue;
        parts.push(props.map((p) => s[p]).join(','));
        if (pseudo) parts.push(s.width + ',' + s.height + ',' + s.left + ',' + s.right);
      }
    }
    return parts.join(';');
  };
  W.markHoverTargets = (limit) => {
    const out = [];
    const seen = new Set();
    let i = 0;
    for (const el of document.querySelectorAll('a[href], button, [role="button"], input[type="submit"]')) {
      if (out.length >= limit) break;
      if (!visible(el)) continue;
      if (el.getAttribute('aria-current')) continue;
      const key = (el.getAttribute('href') || '') + '|' + short(el.innerText || el.value || '', 30);
      if (seen.has(key)) continue;
      seen.add(key);
      el.setAttribute('data-wsc-h', String(i));
      out.push({ i, key, desc: desc(el), cursor: cs(el).cursor });
      i++;
    }
    return out;
  };
  W.hoverSnap = (i) => {
    const el = document.querySelector('[data-wsc-h="' + i + '"]');
    return el ? hoverSnapOf(el) : null;
  };

  // ---------- 動き・フォント・印刷 ----------
  W.motion = () => {
    let keyframes = 0;
    let reducedCss = false;
    eachRule((r) => {
      if (r.type === 7 || r.constructor.name === 'CSSKeyframesRule') keyframes++;
      if (r.conditionText && /prefers-reduced-motion/.test(r.conditionText)) reducedCss = true;
      if (r.media && /prefers-reduced-motion/.test(r.media.mediaText || '')) reducedCss = true;
    });
    const running = document.getAnimations ? document.getAnimations().filter((a) => a.playState === 'running').length : 0;
    return { keyframes, reducedCss, running, gsap: !!(window.gsap || window.TweenMax || window.TweenLite), scrollTrigger: !!window.ScrollTrigger };
  };
  W.fontFaces = () => {
    const missing = [];
    eachRule((r) => {
      if (r.type === 5 || r.constructor.name === 'CSSFontFaceRule') {
        const fd = r.style.getPropertyValue('font-display');
        if (!fd) missing.push(r.style.getPropertyValue('font-family').replace(/["']/g, ''));
      }
    });
    const cross = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'))
      .map((l) => l.href)
      .filter((h) => {
        try {
          return new URL(h).origin !== location.origin;
        } catch (e) {
          return false;
        }
      });
    return { missing: Array.from(new Set(missing)), cross };
  };
  W.printInfo = () => {
    let printRules = false;
    eachRule((r, media) => {
      if ((r.conditionText && /print/.test(r.conditionText)) || (r.media && /print/.test(r.media.mediaText || ''))) printRules = true;
      if (media && /print/.test(media)) printRules = true;
    });
    if (document.querySelector('link[rel~="stylesheet"][media*="print"], style[media*="print"]')) printRules = true;
    const fixed = [];
    for (const el of allIndex()) {
      if (fixed.length >= 5) break;
      const p = cs(el).position;
      if ((p === 'fixed' || p === 'sticky') && visible(el)) fixed.push(desc(el));
    }
    const nav = Array.from(document.querySelectorAll('nav, form, video, iframe')).filter(visible).slice(0, 5).map(desc);
    return { printRules, fixed, nav, width: document.documentElement.scrollWidth };
  };

  // ---------- フォーム ----------
  W.forms = () => {
    const out = [];
    document.querySelectorAll('form').forEach((f, i) => {
      if (!visible(f)) return;
      const inputs = Array.from(f.querySelectorAll('input, select, textarea')).filter((e) => e.type !== 'hidden' && e.type !== 'submit' && e.type !== 'button' && visible(e));
      const search = f.getAttribute('role') === 'search' || f.closest('[role="search"]') || (inputs.length === 1 && (inputs[0].type === 'search' || /^(s|q|search|keyword)$/i.test(inputs[0].name || '')));
      const submit = f.querySelector('button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]');
      out.push({
        i,
        search: !!search,
        method: (f.getAttribute('method') || '').toLowerCase(),
        action: f.getAttribute('action') || '',
        fields: inputs.length,
        required: inputs.filter((e) => e.required || e.getAttribute('aria-required') === 'true').length,
        novalidate: f.noValidate,
        hasSubmit: !!submit,
        captcha: !!f.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="turnstile"]') || !!document.querySelector('script[src*="recaptcha"], script[src*="turnstile"]'),
        desc: desc(f),
      });
    });
    return out;
  };
  W.pageText = () => (document.body ? document.body.innerText : '').slice(0, 20000);

  /** 画像の読み込み方（遅延読み込み・srcset）と背景画像の大きさ */
  W.imagesExtra = () =>
    new Promise((resolve) => {
      const fold = window.innerHeight;
      const lazyAbove = [];
      const eagerBelow = [];
      const noSrcset = [];
      for (const img of Array.from(document.images)) {
        if (!visible(img)) continue;
        const r = img.getBoundingClientRect();
        const top = r.top + window.scrollY;
        const src = short((img.currentSrc || img.src || '').replace(location.origin, ''), 60);
        const lazy = img.loading === 'lazy';
        if (top < fold && lazy && r.width >= 200) lazyAbove.push(src);
        if (top > fold * 1.5 && !lazy && r.width >= 100) eagerBelow.push(src);
        if (r.width >= 600 && !img.srcset && !(img.parentElement && img.parentElement.tagName === 'PICTURE') && !/\.svg/i.test(img.currentSrc || img.src)) noSrcset.push(src + '（表示' + Math.round(r.width) + 'px）');
      }
      const bgs = [];
      for (const el of allIndex()) {
        if (bgs.length >= 20) break;
        const m = (cs(el).backgroundImage || '').match(/url\(["']?([^"')]+)["']?\)/);
        if (!m || /\.svg|^data:/i.test(m[1])) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 50 || r.height < 50) continue;
        bgs.push({ url: m[1], w: r.width, h: r.height, size: cs(el).backgroundSize });
      }
      let pending = bgs.length;
      const big = [];
      const done = () => resolve({ lazyAbove: lazyAbove.slice(0, 5), eagerBelow, noSrcset: noSrcset.slice(0, 5), bgOversize: big.slice(0, 5) });
      if (pending === 0) return done();
      const timer = setTimeout(done, 5000);
      for (const b of bgs) {
        const im = new Image();
        im.onload = im.onerror = () => {
          if (im.naturalWidth && b.size !== 'contain' && im.naturalWidth / b.w > 3) big.push(short(b.url.replace(location.origin, ''), 60) + '（表示' + Math.round(b.w) + 'px / 実寸' + im.naturalWidth + 'px）');
          if (--pending === 0) {
            clearTimeout(timer);
            done();
          }
        };
        im.src = b.url;
      }
    });

  /** cursor: pointer なのにキーボードで操作できない要素（クリック処理だけを付けた div など） */
  W.pointerOnly = () => {
    const out = [];
    const ok = 'a[href], button, input, select, textarea, label, summary, [tabindex], [contenteditable="true"], iframe, video, audio';
    for (const el of allIndex()) {
      if (out.length >= 8) break;
      if (cs(el).cursor !== 'pointer') continue;
      if (el.matches(ok) || el.closest(ok) || el.querySelector(ok)) continue;
      if (el.parentElement && cs(el.parentElement).cursor === 'pointer') continue; // 親で数える
      if (!visible(el)) continue;
      out.push(desc(el));
    }
    return out;
  };

  /** 読み込み性能（LCP・CLS・loadイベントまでの時間） */
  W.perf = () =>
    new Promise((resolve) => {
      let lcp = 0;
      let cls = 0;
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) lcp = Math.max(lcp, e.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (e) {
        /* 非対応のブラウザ */
      }
      setTimeout(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        const bytes = performance.getEntriesByType('resource').reduce((n, r) => n + (r.transferSize || 0), nav ? nav.transferSize || 0 : 0);
        resolve({ load: nav ? Math.round(nav.loadEventEnd) : 0, lcp: Math.round(lcp), cls: Math.round(cls * 1000) / 1000, bytes });
      }, 1500);
    });

  window.__wsc = W;
})();
