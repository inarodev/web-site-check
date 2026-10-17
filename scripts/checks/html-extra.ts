/**
 * 標準：HTMLだけで判定できる追加検査（ブラウザ不要）
 * 構造化データ、OGPの文言、iframe・動画、ランドマーク、電話番号のリンク、画像のファイル名、URLの揺れ、内部リダイレクト
 */
import * as cheerio from 'cheerio';
import { add, bumpPass, check, registerDefs, snippet, UA } from '../lib/core.js';
import type { Options } from '../lib/types.js';
import type { PageData } from './quick.js';

registerDefs({
  'charset-missing': {
    severity: 'fix',
    title: '文字コード（meta charset）の指定がない',
    why: '環境によって文字化けする場合がある。',
    fix: 'head の先頭付近に <meta charset="utf-8"> を入れる。',
  },
  'jsonld-invalid': {
    severity: 'fix',
    title: '構造化データ（JSON-LD）の書式が壊れている',
    why: 'JSONとして読めないため、検索エンジンに無視される。',
    fix: '末尾のカンマや引用符の閉じ忘れを直す。リッチリザルトテストで確認する。',
  },
  'jsonld-incomplete': {
    severity: 'decide',
    title: '構造化データに主要なプロパティが足りない',
    why: '種類ごとに必要なプロパティがないと、リッチリザルトの対象にならない場合がある。',
    fix: '指摘されたプロパティを追加する。Googleのリッチリザルトテストで確認する。',
  },
  'jsonld-missing': {
    severity: 'decide',
    title: '構造化データ（JSON-LD）がない',
    why: '必須ではないが、会社情報・パンくず・記事などを検索エンジンに伝えられる。',
    fix: '案件に合う種類（Organization、LocalBusiness、BreadcrumbList、Articleなど）を追加するか検討する。',
  },
  'og-text-missing': {
    severity: 'decide',
    title: 'og:title / og:description がない',
    why: 'SNSで共有したとき、タイトルや説明が意図しない内容になる場合がある。',
    fix: 'ページごとに og:title と og:description を設定する。',
  },
  'description-duplicate': {
    severity: 'decide',
    title: '複数ページで同じ meta description が使われている',
    why: '検索結果でページの違いが伝わりにくい。',
    fix: 'ページごとに内容に合った説明文にする。',
  },
  'iframe-title': {
    severity: 'fix',
    title: 'iframeにtitleがない',
    why: '読み上げで埋め込みの内容が分からない。',
    fix: 'iframe に内容を表す title 属性を付ける（例：title="アクセスマップ"）。',
    wcag: '4.1.2',
  },
  'media-autoplay-sound': {
    severity: 'fix',
    title: '音声付きで自動再生される動画・音声がある',
    why: '突然音が鳴ると、読み上げソフトの音声がかき消される。',
    fix: '自動再生するなら muted を付ける。音声を聞かせたいなら自動再生をやめる。',
    wcag: '1.4.2',
  },
  'media-no-controls': {
    severity: 'decide',
    title: '動画に操作ボタン（controls）がない',
    why: '止めたり音量を変えたりできない。背景動画など装飾目的なら対応不要の場合がある。',
    fix: 'controls を付けるか、停止ボタンを用意する。装飾なら muted と playsinline を付ける。',
    wcag: '2.2.2',
  },
  'media-no-captions': {
    severity: 'decide',
    title: '動画に字幕（track）がない',
    why: '音声に意味がある動画では、聞こえない人に内容が伝わらない。音声がない装飾動画なら対応不要。',
    fix: '<track kind="captions"> で字幕を付けるか、内容をテキストでも載せる。',
    wcag: '1.2.2',
  },
  'landmark-other': {
    severity: 'decide',
    title: 'header / nav / footer のいずれかがない',
    why: '読み上げソフトのランドマーク移動で、ナビゲーションやフッターに直接移動できない。',
    fix: 'サイト共通部分を <header> <nav> <footer> で囲む。',
    wcag: '1.3.1',
  },
  'tel-not-linked': {
    severity: 'decide',
    title: '電話番号がリンクになっていない',
    why: 'スマホでタップして電話をかけられない。FAX番号など、かけさせたくない番号なら対応不要。',
    fix: '<a href="tel:0312345678">03-1234-5678</a> のようにする。',
  },
  'image-filename': {
    severity: 'decide',
    title: '画像のファイル名に日本語・空白・大文字が含まれている',
    why: 'サーバーや環境によってURLの扱いが変わり、表示されない原因になる場合がある。',
    fix: '半角英小文字・数字・ハイフンのファイル名にする。',
  },
  'url-inconsistent': {
    severity: 'decide',
    title: '同じページへのリンクのURLが揃っていない',
    why: '末尾スラッシュの有無や index.html 付きのURLが混ざると、同じページが別URLとして扱われる場合がある。',
    fix: 'リンクの書き方をどちらかに揃え、canonicalも合わせる。',
  },
  'internal-redirect': {
    severity: 'decide',
    title: '内部リンクの先がリダイレクトしている',
    why: '表示が少し遅くなる。リダイレクトが連続していると、検索エンジンの評価にも影響する場合がある。',
    fix: 'リンクを最終的な遷移先のURLに直す。',
  },
});

const REQUIRED_PROPS: Record<string, string[][]> = {
  Organization: [['name']],
  LocalBusiness: [['name'], ['address']],
  Article: [['headline'], ['datePublished']],
  BlogPosting: [['headline'], ['datePublished']],
  NewsArticle: [['headline'], ['datePublished']],
  Product: [['name'], ['offers', 'review', 'aggregateRating']],
  BreadcrumbList: [['itemListElement']],
  FAQPage: [['mainEntity']],
  WebSite: [['name'], ['url']],
  Event: [['name'], ['startDate'], ['location']],
};

function jsonldNodes(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v)) return v.flatMap(jsonldNodes);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const graph = o['@graph'];
    return [o, ...(graph ? jsonldNodes(graph) : [])];
  }
  return [];
}

const PHONE = /0\d{1,4}-\d{1,4}-\d{3,4}/g;

export async function runHtmlExtra(opts: Options, datas: PageData[]): Promise<void> {
  let anyJsonld = false;
  const descs = new Map<string, string[]>();
  const linkForms = new Map<string, Set<string>>(); // 正規化したパス → 実際に書かれたパス

  for (const d of datas) {
    const $ = cheerio.load(d.html);
    const page = d.page;

    check('charset-missing', page, $('meta[charset]').length > 0 || /charset=/i.test($('meta[http-equiv="Content-Type"]').attr('content') ?? '') ? [] : ['meta charset がない']);

    // 構造化データ
    const invalid: string[] = [];
    const incomplete: string[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      anyJsonld = true;
      const raw = $(el).text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        invalid.push(`${(e as Error).message.split('\n')[0]} ／ ${snippet(raw, 60)}`);
        return;
      }
      for (const node of jsonldNodes(parsed)) {
        const types = ([] as unknown[]).concat(node['@type'] ?? []).map(String);
        for (const t of types) {
          const req = REQUIRED_PROPS[t];
          if (!req) continue;
          const missing = req.filter((alts) => !alts.some((p) => {
            const v = node[p];
            return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
          }));
          if (missing.length > 0) incomplete.push(`${t}: ${missing.map((m) => m.join(' または ')).join('、')} がない`);
        }
      }
    });
    check('jsonld-invalid', page, invalid);
    check('jsonld-incomplete', page, incomplete);

    // OGPの文言・description重複
    const ogMissing = ['og:title', 'og:description'].filter((p) => !($(`meta[property="${p}"]`).attr('content') ?? '').trim());
    check('og-text-missing', page, ogMissing.length > 0 ? [`${ogMissing.join('、')} がない`] : []);
    const desc = ($('meta[name="description"]').attr('content') ?? '').trim();
    if (desc) descs.set(desc, [...(descs.get(desc) ?? []), page]);

    // iframe
    const noTitle: string[] = [];
    $('iframe').each((_, el) => {
      if (!($(el).attr('title') ?? '').trim() && !$(el).attr('aria-label') && $(el).attr('aria-hidden') !== 'true') noTitle.push(snippet($(el).attr('src') ?? $.html(el), 60));
    });
    check('iframe-title', page, noTitle.slice(0, 5));

    // 動画・音声
    const sound: string[] = [];
    const noControls: string[] = [];
    const noCaptions: string[] = [];
    $('video, audio').each((_, el) => {
      const e = $(el);
      const src = snippet(e.attr('src') ?? e.find('source').attr('src') ?? (el as { tagName?: string }).tagName ?? '', 60);
      if (e.attr('autoplay') !== undefined && e.attr('muted') === undefined) sound.push(src);
      if ((el as { tagName?: string }).tagName === 'video') {
        if (e.attr('controls') === undefined) noControls.push(src);
        if (e.find('track[kind="captions"], track[kind="subtitles"]').length === 0 && e.attr('muted') === undefined) noCaptions.push(src);
      }
    });
    check('media-autoplay-sound', page, sound.slice(0, 5));
    check('media-no-controls', page, noControls.slice(0, 5));
    check('media-no-captions', page, noCaptions.slice(0, 5));

    // ランドマーク
    const lm: string[] = [];
    if ($('header, [role="banner"]').length === 0) lm.push('header');
    if ($('nav, [role="navigation"]').length === 0 && $('a[href]').length > 5) lm.push('nav');
    if ($('footer, [role="contentinfo"]').length === 0) lm.push('footer');
    check('landmark-other', page, lm.length > 0 ? [`${lm.join('、')} がない`] : []);

    // 電話番号
    const phones = new Set<string>();
    $('body *').contents().each((_, node) => {
      if (node.type !== 'text') return;
      const parent = $(node).parent();
      if (parent.closest('a[href^="tel:"], script, style, noscript').length > 0) return;
      const txt = (node as unknown as { data: string }).data;
      for (const m of txt.matchAll(PHONE)) {
        const around = txt.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0);
        if (/FAX|ＦＡＸ|ファックス/i.test(around)) continue;
        phones.add(m[0]);
      }
    });
    check('tel-not-linked', page, [...phones].slice(0, 5));

    // 画像のファイル名
    const badNames: string[] = [];
    $('img[src], source[srcset]').each((_, el) => {
      const src = ($(el).attr('src') ?? $(el).attr('srcset') ?? '').split(/[\s,]/)[0] ?? '';
      if (!src || src.startsWith('data:')) return;
      let name = '';
      try {
        name = decodeURIComponent(new URL(src, d.url).pathname.split('/').pop() ?? '');
      } catch {
        name = src;
      }
      if (/[^\x20-\x7e]/.test(name) || /\s/.test(name) || /[A-Z]/.test(name.replace(/\.[a-z0-9]+$/i, ''))) badNames.push(name);
    });
    check('image-filename', page, [...new Set(badNames)].slice(0, 5));

    // URLの揺れ（集計だけ。判定はサイト全体で）
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      try {
        const u = new URL(href, d.url);
        if (u.origin !== opts.base.origin) return;
        const p = u.pathname;
        const norm = p.replace(/\/index\.html?$/, '/').replace(/\/$/, '') || '/';
        if (!linkForms.has(norm)) linkForms.set(norm, new Set());
        linkForms.get(norm)!.add(p);
      } catch {
        /* 無視 */
      }
    });
  }

  if (datas.length > 0) {
    if (!anyJsonld) add('jsonld-missing', datas.map((d) => d.page).slice(0, 3).join(', '), '検査したページに application/ld+json がない');
    else bumpPass();
  }
  for (const [desc, ps] of descs) {
    if (ps.length > 1) add('description-duplicate', ps.join(', '), `「${snippet(desc, 40)}」`);
    else bumpPass();
  }
  const variants = [...linkForms.entries()].filter(([, s]) => s.size > 1);
  if (variants.length > 0) for (const [, s] of variants.slice(0, 5)) add('url-inconsistent', '-', [...s].join(' と '));
  else bumpPass();

  // 内部リンクのリダイレクト
  const targets = new Set<string>();
  for (const d of datas) for (const l of d.internalLinks) targets.add(l);
  const list = [...targets].slice(0, 60);
  for (const t of list) {
    let url = new URL(t, opts.base).href;
    const hops: string[] = [];
    for (let i = 0; i < 5; i++) {
      let res: Response;
      try {
        res = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
      } catch {
        break;
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location')!, url).href;
        hops.push(`${res.status}`);
        url = next;
      } else break;
    }
    if (hops.length > 0) add('internal-redirect', t, `${t} → ${url.replace(opts.base.origin, '')}（${hops.length}回、${hops.join('→')}）`, hops.length >= 2 ? 'fix' : undefined);
    else bumpPass();
  }
}
