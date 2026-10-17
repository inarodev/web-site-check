import * as cheerio from 'cheerio';
import { HtmlValidate } from 'html-validate';
import { add, bumpPass, check, fetchText, headStatus, pushFact, snippet, toPagePath } from '../lib/core.js';
import type { Options } from '../lib/types.js';

const HV_RULES = new Set(['close-order', 'no-dup-id', 'element-permitted-content', 'no-missing-references', 'element-permitted-order', 'element-required-content', 'unrecognized-char-ref', 'no-unknown-elements']);
const hv = new HtmlValidate({ extends: ['html-validate:recommended'] });

async function validateHtml(page: string, html: string): Promise<void> {
  const report = await hv.validateString(html);
  const msgs = report.results.flatMap((r) => r.messages).filter((m) => HV_RULES.has(m.ruleId ?? ''));
  const lines = [...new Set(msgs.map((m) => `${m.line}行目: ${m.message}（${m.ruleId}）`))];
  check('html-validate', page, lines.slice(0, 15));
}

const DUMMY = /lorem ipsum|ダミー(テキスト|文章|画像)?|テストテキスト|サンプルテキスト|ここにテキスト|dummy text|テスト投稿|sample text/i;
const VAGUE = /^(こちら|ここ|詳しくはこちら|詳細はこちら|詳しく見る|もっと見る|more|read more|click here|here|詳細)$/i;
const FILENAME = /(\.(jpe?g|png|gif|webp|avif|svg)$)|(^IMG_\d+)|(^DSC\d+)/i;
const DEV_HOST = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\.local\b|\.test\b)/i;
/** 本番のURLを入れるべき場所（canonical・OGP・sitemap）に残りがちな仮のドメイン */
const PLACEHOLDER_HOST = /^https?:\/\/([^/]*\.)?(example\.(com|org|net|jp)|your-?domain|domain\.com|xxx)/i;
const ANALYTICS: Array<[string, RegExp]> = [
  ['Google タグ（gtag.js / GA4）', /googletagmanager\.com\/gtag\/js|gtag\(\s*['"]config['"]/],
  ['Google タグマネージャー', /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/],
  ['ユニバーサル アナリティクス（終了済み）', /google-analytics\.com\/(analytics|ga)\.js|UA-\d+-\d+/],
  ['Microsoft Clarity', /clarity\.ms\/tag/],
  ['Meta ピクセル', /connect\.facebook\.net\/.+fbevents\.js|fbq\(/],
  ['Yahoo!広告', /yjtag|s\.yimg\.jp\/images\/listing\/tool\/cv/],
  ['Plausible', /plausible\.io\/js/],
];


function accessibleName($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string {
  const aria = el.attr('aria-label') ?? el.attr('title') ?? '';
  if (aria.trim()) return aria.trim();
  const labelledby = el.attr('aria-labelledby');
  if (labelledby) {
    const txt = labelledby.split(/\s+/).map((id) => $(`#${id}`).text()).join(' ').trim();
    if (txt) return txt;
  }
  const imgAlt = el.find('img[alt]').map((_, i) => $(i).attr('alt') ?? '').get().join(' ').trim();
  const svgTitle = el.find('svg title').text().trim();
  return (el.text() + ' ' + imgAlt + ' ' + svgTitle).replace(/\s+/g, ' ').trim();
}

export interface PageData {
  page: string;
  url: URL;
  html: string;
  title: string;
  internalLinks: Set<string>;
  externalLinks: Set<string>;
}

export async function analyzeHtml(opts: Options, page: string, res: { status: number; headers: Headers; body: string }, seenTitles: Map<string, string[]>): Promise<PageData> {
  const url = new URL(page, opts.base);
  const $ = cheerio.load(res.body);
  const html = res.body;
  const lines = html.split('\n');
  void lines;

  await validateHtml(page, html);

  // lang
  check('lang-missing', page, ($('html').attr('lang') ?? '').trim() ? [] : ['<html> にlangがない']);

  // title
  const title = $('head title').first().text().trim();
  check('title-missing', page, title ? [] : ['<title> が空、または存在しない']);
  if (title) {
    const arr = seenTitles.get(title) ?? [];
    arr.push(page);
    seenTitles.set(title, arr);
  }

  // meta
  const meta = (name: string): string => ($(`meta[name="${name}"]`).attr('content') ?? '').trim();
  const prop = (name: string): string => ($(`meta[property="${name}"]`).attr('content') ?? '').trim();
  check('description-missing', page, meta('description') ? [] : ['meta descriptionがない']);

  const viewport = meta('viewport');
  check('viewport-missing', page, viewport ? [] : ['viewportのmetaがない']);
  if (viewport) {
    const blocked = /user-scalable\s*=\s*(no|0)/i.test(viewport) || /maximum-scale\s*=\s*1(\.0)?\b/i.test(viewport);
    check('viewport-zoom-blocked', page, blocked ? [viewport] : []);
  }

  const ogImage = prop('og:image');
  check('og-image-missing', page, ogImage ? [] : ['og:imageがない']);
  check('twitter-card-missing', page, meta('twitter:card') ? [] : ['twitter:cardがない']);

  const canonical = ($('link[rel="canonical"]').attr('href') ?? '').trim();
  check('canonical-missing', page, canonical ? [] : ['canonicalがない']);
  const localRefs = [canonical, prop('og:url'), ogImage].filter((v) => v && (DEV_HOST.test(v) || PLACEHOLDER_HOST.test(v)));
  check('og-image-relative', page, ogImage && !/^https?:\/\//i.test(ogImage) ? [ogImage] : []);
  check('canonical-local', page, localRefs.map((v) => v));

  // favicon（ファイル存在は後でまとめて確認するため、宣言だけ確認）
  const iconHref = $('link[rel~="icon"]').first().attr('href');
  if (!iconHref) {
    const ico = await headStatus(new URL('/favicon.ico', opts.base).href);
    check('favicon-missing', page, ico === 200 ? [] : ['link[rel=icon] がなく、/favicon.ico も取得できない']);
  } else {
    const st = await headStatus(new URL(iconHref, url).href);
    check('favicon-broken', page, st !== null && st < 400 ? [] : [`${iconHref}（HTTP ${st ?? '接続失敗'}）`]);
  }
  check('apple-touch-icon-missing', page, $('link[rel="apple-touch-icon"]').length > 0 ? [] : ['apple-touch-iconがない']);

  // og:image の実在
  if (ogImage && !DEV_HOST.test(ogImage)) {
    const st = await headStatus(new URL(ogImage, url).href);
    check('og-image-broken', page, st !== null && st < 400 ? [] : [`${ogImage}（HTTP ${st ?? '接続失敗'}）`]);
  }

  // hreflang
  const hreflangs = $('link[rel="alternate"][hreflang]').map((_, el) => $(el).attr('hreflang') ?? '').get();
  if (hreflangs.length > 0) {
    const probs: string[] = [];
    if (!hreflangs.includes('x-default')) probs.push('x-defaultがない');
    const selfLang = ($('html').attr('lang') ?? '').split('-')[0];
    if (selfLang && !hreflangs.some((h) => h.split('-')[0] === selfLang)) probs.push(`html lang="${selfLang}" に対応するhreflangがない（自己参照なし）`);
    check('hreflang-incomplete', page, probs);
  }

  // noindex
  const robotsMeta = `${meta('robots')} ${meta('googlebot')}`;
  const xrobots = res.headers.get('x-robots-tag') ?? '';
  const noindexProblems: string[] = [];
  if (/noindex/i.test(robotsMeta)) noindexProblems.push(`meta robots: ${robotsMeta.trim()}`);
  if (/noindex/i.test(xrobots)) noindexProblems.push(`X-Robots-Tag: ${xrobots}`);
  check('noindex-found', page, noindexProblems);

  // ダミーテキスト・コメント・開発URL
  const bodyText = $('body').text();
  const dummyMatch = bodyText.match(DUMMY);
  check('dummy-text', page, dummyMatch ? [`「${dummyMatch[0]}」を含む`] : []);

  const comments: string[] = [];
  for (const m of html.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (/(TODO|FIXME|XXX|HACK|あとで|修正|確認)/i.test(m[1]!) && !/\[if /i.test(m[1]!)) comments.push(snippet(m[1]!));
  }
  check('dev-comment', page, comments.slice(0, 5));

  const devUrls: string[] = [];
  $('[href],[src],[srcset],[content],[action]').each((_, el) => {
    for (const attr of ['href', 'src', 'srcset', 'content', 'action']) {
      const v = $(el).attr(attr);
      if (v && /^(https?:)?\/\//i.test(v.trim()) && DEV_HOST.test(v) && !(new URL(v, url).origin === opts.base.origin && DEV_HOST.test(opts.base.hostname))) {
        devUrls.push(`${attr}="${snippet(v)}"`);
      }
    }
  });
  check('dev-url-leak', page, [...new Set(devUrls)].slice(0, 5));

  // 混在コンテンツ
  if (url.protocol === 'https:') {
    const mixed: string[] = [];
    $('[src],[href][rel="stylesheet"],link[href]').each((_, el) => {
      const v = $(el).attr('src') ?? $(el).attr('href') ?? '';
      if (/^http:\/\//i.test(v)) mixed.push(snippet(v));
    });
    check('mixed-content', page, [...new Set(mixed)].slice(0, 5));
  }

  // 構造
  check('landmark-main', page, $('main, [role="main"]').length > 0 ? [] : ['<main> がない']);

  const h1 = $('h1').length;
  check('heading-h1', page, h1 === 1 ? [] : [`h1が${h1}個`]);
  const levels = $('h1,h2,h3,h4,h5,h6').map((_, el) => ({ level: Number((el as any).tagName.slice(1)), text: snippet($(el).text(), 30) })).get();
  const skips: string[] = [];
  for (let i = 1; i < levels.length; i++) {
    if (levels[i]!.level - levels[i - 1]!.level > 1) skips.push(`h${levels[i - 1]!.level} → h${levels[i]!.level}「${levels[i]!.text}」`);
  }
  check('heading-skip', page, skips.slice(0, 5));

  const empties: string[] = [];
  $('span,div').each((_, el) => {
    const e = $(el);
    if (e.children().length === 0 && e.text().trim() === '' && !e.attr('aria-hidden') && !e.attr('id') && !e.attr('class')) {
      empties.push(snippet($.html(el)));
    }
  });
  check('empty-element', page, empties.slice(0, 5));

  const clicks: string[] = [];
  $('div[onclick],span[onclick]').each((_, el) => {
    clicks.push(snippet($.html(el)));
  });
  check('click-non-interactive', page, clicks.slice(0, 5));

  // 画像
  const altMissing: string[] = [];
  const altFile: string[] = [];
  const noSize: string[] = [];
  $('img').each((_, el) => {
    const e = $(el);
    const alt = e.attr('alt');
    const src = e.attr('src') ?? e.attr('data-src') ?? '';
    if (alt === undefined) altMissing.push(snippet(src));
    else if (alt.trim() && FILENAME.test(alt.trim())) altFile.push(`alt="${snippet(alt)}"`);
    if (!e.attr('width') || !e.attr('height')) noSize.push(snippet(src));
  });
  check('img-alt-missing', page, altMissing.slice(0, 5));
  check('img-alt-filename', page, altFile.slice(0, 5));
  check('img-no-size', page, noSize.slice(0, 5));

  // リンク・ボタン
  const emptyLinks: string[] = [];
  const vague: string[] = [];
  const noName: string[] = [];
  const blankRel: string[] = [];
  const telMail: string[] = [];
  const internalLinks = new Set<string>();
  const externalLinks = new Set<string>();

  $('a').each((_, el) => {
    const e = $(el);
    const href = (e.attr('href') ?? '').trim();
    const text = accessibleName($, e);
    if (e.attr('href') !== undefined && (href === '' || href === '#' || /^javascript:/i.test(href))) emptyLinks.push(snippet($.html(el)));
    if (e.attr('href') !== undefined && !text) noName.push(snippet($.html(el)));
    if (text && VAGUE.test(text) && !e.attr('aria-label')) vague.push(`「${text}」 → ${snippet(href, 40)}`);
    if (e.attr('target') === '_blank' && !/noopener/i.test(e.attr('rel') ?? '')) blankRel.push(snippet(href, 60));
    if (/^tel:/i.test(href) && !/^tel:\+?[0-9\-\s()]+$/i.test(href)) telMail.push(href);
    if (/^mailto:/i.test(href) && !/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+/i.test(href)) telMail.push(href);
    if (href && !/^(mailto:|tel:|javascript:|#)/i.test(href)) {
      try {
        const u = new URL(href, url);
        u.hash = '';
        if (u.origin === opts.base.origin) internalLinks.add(toPagePath(u));
        else if (/^https?:$/.test(u.protocol)) externalLinks.add(u.href);
      } catch {
        /* 無視 */
      }
    }
  });
  $('button').each((_, el) => {
    if (!accessibleName($, $(el))) noName.push(snippet($.html(el)));
  });
  check('link-empty', page, emptyLinks.slice(0, 5));
  check('link-vague-text', page, vague.slice(0, 5));
  check('link-no-name', page, noName.slice(0, 5));
  check('link-blank-rel', page, blankRel.slice(0, 5));
  check('tel-mailto-invalid', page, telMail.slice(0, 5));

  // フォーム部品のラベル
  const noLabel: string[] = [];
  $('input,select,textarea').each((_, el) => {
    const e = $(el);
    const type = (e.attr('type') ?? 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return;
    const id = e.attr('id');
    const labelled = (id && $(`label[for="${id}"]`).length > 0) || e.closest('label').length > 0 || e.attr('aria-label') || e.attr('aria-labelledby') || e.attr('title');
    if (!labelled) noLabel.push(snippet($.html(el)));
  });
  check('form-label-missing', page, noLabel.slice(0, 5));

  // 文字（読み上げ）
  const kanaRuns = bodyText.match(/[\uFF66-\uFF9F]+/g) ?? [];
  const kana = [...new Set(kanaRuns)].slice(0, 5).map((k) => `「${k}」`);
  check('halfwidth-kana', page, kana);

  const spaceProblems: string[] = [];
  const capsProblems: string[] = [];
  const capsAcronym: string[] = [];
  $('h1,h2,h3,h4,h5,h6,a,button,nav li,summary,label').each((_, el) => {
    const raw = $(el).clone().children('script,style').remove().end().text();
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const cjkSpaced = /[぀-ヿ一-鿿]\u3000+[぀-ヿ一-鿿]/.test(raw);
    const latinSpaced = /^[A-Za-z]( [A-Za-z]){3,}$/.test(t);
    if (cjkSpaced || latinSpaced) spaceProblems.push(snippet(raw.replace(/\u3000/g, '□'), 40));
    for (const w of t.match(/\b[A-Z]{2,}\b/g) ?? []) {
      if (w.length >= 4) capsProblems.push(`「${w}」（${snippet(t, 30)}）`);
      else capsAcronym.push(`「${w}」（${snippet(t, 30)}）`);
    }
  });
  check('fullwidth-space', page, [...new Set(spaceProblems)].slice(0, 5));
  check('all-caps-text', page, [...new Set(capsProblems)].slice(0, 5));
  // 2〜3文字の大文字は略語の可能性が高いので、要判断として出す
  if (capsAcronym.length > 0) for (const c of [...new Set(capsAcronym)].slice(0, 3)) add('all-caps-text', page, c, 'decide');

  // 要判断の質問を作るための判断材料
  for (const [name, re] of ANALYTICS) if (re.test(html)) pushFact('analytics', name);
  const privacy = $('a[href]').toArray().some((a) => /privacy|プライバシー|個人情報/i.test(`${$(a).attr('href')} ${$(a).text()}`));
  if (privacy) pushFact('privacyPolicyLink', page);
  const forms = $('form').toArray().filter((f) => $(f).find('input:not([type="hidden"]):not([type="search"]), textarea').length > 1).length;
  if (forms > 0) pushFact('formPages', page);
  const langs = $('[lang]').toArray().map((e) => ($(e).attr('lang') ?? '').split('-')[0]!.toLowerCase());
  for (const l of new Set(langs)) if (l) pushFact('languages', l);

  return { page, url, html, title, internalLinks, externalLinks };
}

// ---------- サイト全体の検査 ----------
export async function siteLevelChecks(opts: Options, pages: PageData[]): Promise<void> {
  // robots.txt
  const robots = await fetchText(new URL('/robots.txt', opts.base).href);
  if (!robots || robots.status !== 200) add('robots-missing', '/robots.txt', `HTTP ${robots?.status ?? '接続失敗'}`);
  else if (/^\s*Disallow:\s*\/\s*$/im.test(robots.body) && /^\s*User-agent:\s*\*/im.test(robots.body)) add('robots-disallow-all', '/robots.txt', 'User-agent: * に Disallow: / がある');
  else bumpPass();

  // sitemap.xml
  const sm = await fetchText(new URL('/sitemap.xml', opts.base).href);
  if (!sm || sm.status !== 200) add('sitemap-missing', '/sitemap.xml', `HTTP ${sm?.status ?? '接続失敗'}`);
  else {
    const locs = [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!);
    const bad = [...new Set(locs.filter((l) => DEV_HOST.test(l) || PLACEHOLDER_HOST.test(l)).map((l) => { try { return new URL(l).host; } catch { return l; } }))];
    check('sitemap-placeholder', '/sitemap.xml', bad.map((h) => `${h} のURLが含まれる`));
  }

  // 404
  const nf = await fetchText(new URL('/__web-site-check-not-found__', opts.base).href);
  if (nf && nf.status === 200) add('soft-404', '/__web-site-check-not-found__', 'HTTP 200');
  else if (nf) bumpPass();

  // title重複
  // （analyzeHtml内で集計し、呼び出し側でまとめて判定する）

  // 内部リンク切れ
  const targets = new Set<string>();
  const sources = new Map<string, string>();
  const crawled = new Set(pages.map((p) => p.page));
  for (const p of pages) {
    for (const l of p.internalLinks) {
      if (!crawled.has(l) && !targets.has(l)) {
        targets.add(l);
        sources.set(l, p.page);
      }
    }
  }
  const list = [...targets].slice(0, 100);
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < list.length) {
      const t = list[idx++]!;
      const st = await headStatus(new URL(t, opts.base).href);
      if (st === null || st >= 400) add('link-broken', sources.get(t) ?? t, `${t}（HTTP ${st ?? '接続失敗'}）`);
      else bumpPass();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // 外部リンク（明示的に許可された場合のみ）
  if (opts.checkExternal) {
    const ext = new Map<string, string>();
    for (const p of pages) for (const l of p.externalLinks) if (!ext.has(l)) ext.set(l, p.page);
    const urls = [...ext.keys()].slice(0, 50);
    for (const u of urls) {
      const st = await headStatus(u);
      if (st === null || st >= 400) add('link-broken', ext.get(u)!, `${u}（HTTP ${st ?? '接続失敗'}）`, st === null || st === 404 || st === 410 ? 'fix' : 'review');
      else bumpPass();
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

interface ImgInfo {
  src: string;
  naturalWidth: number;
  clientWidth: number;
  clientHeight: number;
  inPicture: boolean;
}

export async function browserChecks(opts: Options, pages: string[]): Promise<void> {
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    add('browser-skipped', '-', 'playwrightが導入されていません');
    return;
  }
  let browser: import('playwright').Browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    add('browser-skipped', '-', `Chromiumを起動できません: ${(e as Error).message.split('\n')[0]}`);
    return;
  }
  try {
    for (const page of pages) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const pw = await ctx.newPage();
      const errors: string[] = [];
      const failed: string[] = [];
      const images = new Map<string, { status: number; contentType: string; bytes: number }>();

      pw.on('console', (m) => {
        if (m.type() === 'error') errors.push(snippet(m.text(), 120));
      });
      pw.on('pageerror', (e) => errors.push(snippet(`未処理の例外: ${e.message}`, 120)));
      pw.on('requestfailed', (r) => failed.push(`${snippet(r.url(), 80)}（${r.failure()?.errorText ?? '失敗'}）`));
      pw.on('response', async (r) => {
        const ct = r.headers()['content-type'] ?? '';
        if (r.status() >= 400 && !/favicon/.test(r.url())) failed.push(`${snippet(r.url(), 80)}（HTTP ${r.status()}）`);
        if (ct.startsWith('image/')) {
          let bytes = Number(r.headers()['content-length'] ?? 0);
          if (!bytes) {
            try {
              bytes = (await r.body()).length;
            } catch {
              bytes = 0;
            }
          }
          images.set(r.url(), { status: r.status(), contentType: ct.split(';')[0]!, bytes });
        }
      });

      try {
        await pw.goto(new URL(page, opts.base).href, { waitUntil: 'networkidle', timeout: 30000 });
        // 遅延読み込みの画像を読み込ませる
        await pw.evaluate(async () => {
          const step = Math.max(300, window.innerHeight * 0.8);
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 120));
          }
          window.scrollTo(0, 0);
        });
        await pw.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);

        const imgs: ImgInfo[] = await pw.evaluate(() =>
          Array.from(document.images).map((img) => ({
            src: img.currentSrc || img.src,
            naturalWidth: img.naturalWidth,
            clientWidth: img.clientWidth,
            clientHeight: img.clientHeight,
            inPicture: img.parentElement?.tagName === 'PICTURE',
          })),
        );

        check('console-error', page, [...new Set(errors)].slice(0, 5));
        check('request-failed', page, [...new Set(failed)].slice(0, 5));

        const seen = new Set<string>();
        const fmt: string[] = [];
        const gif: string[] = [];
        const over3: string[] = [];
        const over2: string[] = [];
        const heavy: string[] = [];
        let total = 0;
        for (const im of imgs) {
          if (!im.src || seen.has(im.src) || im.clientWidth < 2) continue;
          seen.add(im.src);
          const info = images.get(im.src);
          const name = snippet(im.src.replace(opts.base.origin, ''), 70);
          if (info) total += info.bytes;
          const ct = info?.contentType ?? '';
          if (ct === 'image/jpeg' || ct === 'image/png') fmt.push(`${name}（${ct}）`);
          if (ct === 'image/gif') gif.push(name);
          if (im.naturalWidth > 0 && !ct.includes('svg')) {
            const ratio = im.naturalWidth / im.clientWidth;
            const detail = `${name}（表示${im.clientWidth}px / 実寸${im.naturalWidth}px = ${ratio.toFixed(1)}倍${info ? `, ${Math.round(info.bytes / 1024)}KB` : ''}）`;
            if (ratio > 3) over3.push(detail);
            else if (ratio > 2) over2.push(detail);
          }
          if (info && info.bytes > 100 * 1024 && im.clientHeight > 0) {
            const bpp = info.bytes / (im.clientWidth * 2 * im.clientHeight * 2);
            const limit = ct === 'image/webp' || ct === 'image/avif' ? 0.3 : 0.5;
            if (bpp > limit) heavy.push(`${name}（${Math.round(info.bytes / 1024)}KB / 表示${im.clientWidth}×${im.clientHeight}px、2倍面積あたり${bpp.toFixed(2)}バイト/px）`);
          }
        }
        check('image-format', page, fmt.slice(0, 8));
        check('image-gif', page, gif.slice(0, 5));
        check('image-oversize', page, over3.slice(0, 8), 'fix');
        check('image-oversize', page, over2.slice(0, 8), 'decide');
        check('image-heavy', page, heavy.slice(0, 8));
        check('image-total-heavy', page, total > 3 * 1024 * 1024 ? [`画像の合計 ${(total / 1024 / 1024).toFixed(1)}MB`] : []);
      } catch (e) {
        add('fetch-failed', page, `ブラウザで開けませんでした: ${(e as Error).message.split('\n')[0]}`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
}
