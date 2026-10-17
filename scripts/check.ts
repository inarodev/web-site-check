/**
 * web-site-check: 検査スクリプト（入口）
 *
 * ローカルで起動しているサイトを検査し、findings.json と report.draft.md（下書き）を出力する。
 *
 * 使い方:
 *   npx tsx check.ts --base http://localhost:3000 [--profile quick|standard|full]
 *                    [--pages /,/about] [--max 20] [--deep-pages 5] [--out DIR]
 *                    [--project DIR] [--no-browser] [--no-lighthouse] [--check-external]
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { add, bumpPass, fetchText, getFacts, getPass, registerDefs, renderReport, runModule, snippet, sortedFindings, summarize, toPagePath } from './lib/core.js';
import type { Options, Profile } from './lib/types.js';
import { analyzeHtml, browserChecks, siteLevelChecks } from './checks/quick.js';
import type { PageData } from './checks/quick.js';
import { DEEP_DEFS } from './lib/defs-deep.js';
import { launchChromium, pickRepresentative } from './lib/browser.js';
import type { DeepCtx } from './lib/browser.js';

registerDefs(DEEP_DEFS);

// ---------- 引数 ----------
function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const baseRaw = get('base');
  if (!baseRaw) {
    console.error('使い方: npx tsx check.ts --base http://localhost:3000 [--profile quick|standard|full] [--pages /,/about] [--max 20] [--deep-pages 5] [--out DIR] [--project DIR] [--no-browser] [--no-lighthouse] [--check-external]');
    process.exit(1);
  }
  const profile = (get('profile') ?? 'quick') as Profile;
  if (!['quick', 'standard', 'full'].includes(profile)) {
    console.error(`--profile は quick / standard / full のいずれかです: ${profile}`);
    process.exit(1);
  }
  return {
    base: new URL(baseRaw),
    pages: (get('pages') ?? '/').split(',').map((s) => s.trim()).filter(Boolean),
    max: Number(get('max') ?? 20),
    out: path.resolve(get('out') ?? '.web-site-check'),
    browser: !has('no-browser'),
    checkExternal: has('check-external'),
    profile,
    deepPages: Number(get('deep-pages') ?? (profile === 'full' ? 8 : 5)),
    project: get('project') ? path.resolve(get('project')!) : undefined,
    noLighthouse: has('no-lighthouse'),
  };
}

// ---------- ページ探索 ----------
const SKIP_EXT = /\.(pdf|zip|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|css|js|json|xml|txt|woff2?|ttf)$/i;

async function discoverPages(opts: Options): Promise<string[]> {
  const queue: string[] = [...opts.pages];
  const seen = new Set<string>();
  const result: string[] = [];

  // sitemapのパスを追加（ホスト名は本番でも、パスだけ使う）
  const sm = await fetchText(new URL('/sitemap.xml', opts.base).href);
  if (sm && sm.status === 200 && sm.body.includes('<loc>')) {
    for (const m of sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      try {
        queue.push(toPagePath(new URL(m[1]!)));
      } catch {
        /* 無視 */
      }
    }
  }

  while (queue.length > 0 && result.length < opts.max) {
    const p = queue.shift()!;
    const url = new URL(p, opts.base);
    const key = toPagePath(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const res = await fetchText(url.href);
    if (!res) {
      add('fetch-failed', key, url.href);
      continue;
    }
    if (res.status === 401) {
      add('auth-required', key, 'HTTP 401');
      continue;
    }
    if (res.status >= 400) continue; // エラーページは検査対象にせず、リンク切れ検査に回す
    if (!(res.headers.get('content-type') ?? '').includes('html')) continue;
    result.push(key);
    const $ = cheerio.load(res.body);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
      try {
        const u = new URL(href, url);
        u.hash = '';
        if (u.origin !== opts.base.origin || SKIP_EXT.test(u.pathname)) return;
        queue.push(toPagePath(u));
      } catch {
        /* 無視 */
      }
    });
  }
  return result;
}

// ---------- 標準・フル ----------
async function deepChecks(opts: Options, pages: string[], datas: PageData[]): Promise<void> {
  const full = opts.profile === 'full';

  // ブラウザを使わない追加検査
  const { runHtmlExtra } = await import('./checks/html-extra.js');
  await runModule('HTMLの追加検査（構造化データ・iframe・動画など）', () => runHtmlExtra(opts, datas));
  const { runExposedFiles, runReleaseExtra } = await import('./checks/release-extra.js');
  await runModule('公開してはいけないファイルの露出', () => runExposedFiles(opts));
  if (full) await runModule('公開前の追加検査（ソースマップ・圧縮・キャッシュ・依存パッケージ）', () => runReleaseExtra(opts, datas));

  if (!opts.browser) {
    add('deep-browser-skipped', '-', '--no-browser が指定されたため、ブラウザを使う検査を省略しました');
    return;
  }
  const browser = await launchChromium();
  if (!browser) {
    add('deep-browser-skipped', '-', 'Chromiumを起動できませんでした');
    return;
  }
  const ctx: DeepCtx = { opts, browser, pages: pickRepresentative(pages, opts.deepPages), allPages: pages };
  console.log(`  代表ページ（${ctx.pages.length}件）: ${ctx.pages.join(', ')}`);
  try {
    const { runLayout } = await import('./checks/layout.js');
    await runModule('レイアウト（はみ出し・文字サイズ・100vh・タップ領域）', () => runLayout(ctx));
    const { runDisplayModes } = await import('./checks/display-modes.js');
    await runModule('表示モード（ダークモード・文字サイズ拡大・テキスト間隔）', () => runDisplayModes(ctx));
    const { runResilience } = await import('./checks/resilience.js');
    await runModule('JS無効・スクリプト停止時の表示', () => runResilience(ctx));
    const { runA11yExtra } = await import('./checks/a11y-extra.js');
    await runModule('読み上げの追加検査', () => runA11yExtra(ctx));
    const { runForms } = await import('./checks/forms.js');
    await runModule('フォーム（送信はすべてモック）', () => runForms(ctx));

    if (full) {
      const { runInteraction } = await import('./checks/interaction.js');
      await runModule('ホバー・キーボード操作', () => runInteraction(ctx));
      const { runPrint } = await import('./checks/print.js');
      await runModule('印刷', () => runPrint(ctx));
      const { runNetwork } = await import('./checks/network.js');
      await runModule('低速回線・外部リソース失敗・動きの抑制', () => runNetwork(ctx));
      const { runEngines } = await import('./checks/engines.js');
      await runModule('複数ブラウザ・モバイル端末', () => runEngines(ctx));
    }
  } finally {
    await browser.close();
  }

  if (!opts.noLighthouse) {
    const { runLighthouse } = await import('./checks/lighthouse.js');
    await runModule('Lighthouse', () => runLighthouse(opts, pickRepresentative(pages, full ? 3 : 2)));
  } else {
    add('lighthouse-skipped', '-', '--no-lighthouse が指定されました');
  }
}

// ---------- メイン ----------
async function main(): Promise<void> {
  const t0 = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  console.log(`対象: ${opts.base.origin}（プロファイル: ${opts.profile}）`);

  // 前回の証跡を消す（古いスクリーンショットが混ざらないように）
  for (const d of ['screenshots', 'print', 'aria', 'lighthouse']) await rm(path.join(opts.out, d), { recursive: true, force: true });

  const pages = await discoverPages(opts);
  console.log(`検査ページ: ${pages.length}件`);
  if (pages.length === 0) {
    console.error('検査できるページがありません。サイトが起動しているか、--base を確認してください。');
  }

  console.log('クイック検査');
  const seenTitles = new Map<string, string[]>();
  const datas: PageData[] = [];
  for (const page of pages) {
    const res = await fetchText(new URL(page, opts.base).href);
    if (!res) {
      add('fetch-failed', page, '取得に失敗');
      continue;
    }
    datas.push(await analyzeHtml(opts, page, res, seenTitles));
  }
  for (const [t, ps] of seenTitles) {
    if (ps.length > 1) add('title-duplicate', ps.join(', '), `「${snippet(t, 40)}」`);
    else bumpPass();
  }
  await siteLevelChecks(opts, datas);
  if (opts.browser) await runModule('ブラウザ検査（画像・コンソール）', () => browserChecks(opts, pages));
  else add('browser-skipped', '-', '--no-browser が指定されました');

  if (opts.profile !== 'quick') {
    console.log(opts.profile === 'full' ? 'フル検査' : '標準検査');
    await deepChecks(opts, pages, datas);
  }

  const elapsed = (Date.now() - t0) / 1000;
  const list = sortedFindings();
  await mkdir(opts.out, { recursive: true });
  const summary = summarize(list);
  await writeFile(
    path.join(opts.out, 'findings.json'),
    JSON.stringify({ base: opts.base.origin, profile: opts.profile, elapsedSec: Math.round(elapsed), pages, summary, facts: getFacts(), findings: list }, null, 2),
  );
  // 下書き。Claudeが整形した完成版を report.md に保存する
  await writeFile(path.join(opts.out, 'report.draft.md'), renderReport(opts, pages, list, elapsed));

  console.log(`完了（${Math.round(elapsed)}秒）: 🔴${summary.fix.items}項目(${summary.fix.spots}箇所) 🟠${summary.decide.items}項目(${summary.decide.spots}箇所) 🟡${summary.review.items} ⚪${summary.manual.items} 🟢合格${getPass()}件`);
  console.log(`出力: ${path.join(opts.out, 'findings.json')} / ${path.join(opts.out, 'report.draft.md')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
