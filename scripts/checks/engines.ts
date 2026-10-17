/**
 * フル：複数ブラウザとモバイル端末
 * Chromium を基準に、WebKit（Safari相当）と Firefox で、コンソールエラー・横スクロール・ページの高さの差を比べる。
 * iPhone・Android のエミュレーションでスクリーンショットを撮る。
 */
import type { Browser, BrowserContextOptions } from 'playwright';
import { add, bumpPass, registerDefs, snippet } from '../lib/core.js';
import { gotoPage, newSafeContext, probe, saveShot, scrollThrough } from '../lib/browser.js';
import type { DeepCtx } from '../lib/browser.js';

registerDefs({
  'engine-console-error': {
    severity: 'fix',
    title: '特定のブラウザでだけJavaScriptのエラーが出る',
    why: 'Chrome では動くが、Safari（WebKit）や Firefox では処理が途中で止まる可能性がある。',
    fix: 'エラーの内容を確認し、未対応のAPIや書き方を直す（必要ならポリフィルを入れる）。',
  },
  'engine-overflow': {
    severity: 'fix',
    title: '特定のブラウザでだけ横スクロールが出る',
    why: 'ブラウザごとのCSSの解釈の違いで、レイアウトがはみ出している。',
    fix: 'スクリーンショットで該当箇所を確認し、そのブラウザで崩れる指定を直す。',
  },
  'engine-diff': {
    severity: 'review',
    title: 'ブラウザによってページの長さが大きく違う',
    why: '要素が表示されない、画像の大きさが違うなど、見た目に差がある可能性がある。',
    fix: 'スクリーンショットを見比べて、表示の差を確認する。',
  },
  'mobile-screenshot': {
    severity: 'review',
    title: 'スマホ端末での見た目（スクリーンショット）',
    why: 'iPhone・Androidの画面サイズで、全体の見た目を確認するため。アドレスバーの伸縮など、実機でしか分からない挙動は含まれない。',
    fix: 'スクリーンショットを見て崩れがないか確認する。最終確認は実機で行う。',
  },
  'engines-missing': {
    severity: 'manual',
    title: '一部のブラウザで検査できなかった',
    why: 'WebKit（Safari相当）・Firefox が導入されていないため、Chrome以外での表示を確認できていない。',
    fix: 'スキルの scripts フォルダで npx playwright install webkit firefox を実行してから再実行するか、実際のブラウザで確認する。',
  },
});

interface Measure {
  height: number;
  overflow: boolean;
  errors: string[];
  shot?: string;
}

async function measure(browser: Browser, ctx: DeepCtx, page: string, label: string, options: BrowserContextOptions): Promise<Measure> {
  const bc = await newSafeContext(browser, options);
  const pw = await bc.newPage();
  const errors: string[] = [];
  pw.on('pageerror', (e) => errors.push(snippet(e.message, 100)));
  pw.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(snippet(m.text(), 100));
  });
  try {
    await gotoPage(pw, ctx.opts, page);
    await scrollThrough(pw);
    const o = await probe<{ overflow: boolean }>(pw, 'overflow');
    const height = Number(await pw.evaluate('document.documentElement.scrollHeight'));
    const shot = await saveShot(pw, ctx.opts, page, label, false);
    return { height, overflow: o.overflow, errors: [...new Set(errors)], shot };
  } finally {
    await bc.close();
  }
}

export async function runEngines(ctx: DeepCtx): Promise<void> {
  const pw = await import('playwright');
  const engines: Array<{ name: string; label: string; browser: Browser }> = [];
  const missing: string[] = [];
  for (const [name, label] of [['webkit', 'WebKit（Safari相当）'], ['firefox', 'Firefox']] as const) {
    try {
      engines.push({ name, label, browser: await pw[name].launch() });
    } catch {
      missing.push(label);
    }
  }
  if (missing.length > 0) add('engines-missing', '-', `未導入：${missing.join('、')}`);

  try {
    const pages = ctx.pages.slice(0, 3);
    for (const page of pages) {
      for (const [vpLabel, viewport] of [['pc', { width: 1440, height: 900 }], ['sp', { width: 390, height: 844 }]] as const) {
        const base = await measure(ctx.browser, ctx, page, `chromium-${vpLabel}`, { viewport });
        for (const e of engines) {
          const m = await measure(e.browser, ctx, page, `${e.name}-${vpLabel}`, { viewport });
          const onlyHere = m.errors.filter((x) => !base.errors.includes(x));
          if (onlyHere.length > 0) for (const x of onlyHere.slice(0, 3)) add('engine-console-error', page, `${e.label}（${viewport.width}px）：${x}`, undefined, m.shot);
          else bumpPass();
          if (m.overflow && !base.overflow) add('engine-overflow', page, `${e.label}（${viewport.width}px）`, undefined, m.shot);
          else bumpPass();
          const diff = base.height > 0 ? Math.abs(m.height - base.height) / base.height : 0;
          if (diff > 0.15) add('engine-diff', page, `${e.label}（${viewport.width}px）：${m.height}px（Chromium ${base.height}px、差${Math.round(diff * 100)}%）`, undefined, m.shot);
          else bumpPass();
        }
      }
    }

    // スマホ端末のエミュレーション
    const devices = pw.devices;
    const iphoneBrowser = engines.find((e) => e.name === 'webkit')?.browser ?? ctx.browser;
    const targets: Array<{ label: string; browser: Browser; device: BrowserContextOptions }> = [
      { label: 'iphone', browser: iphoneBrowser, device: { ...devices['iPhone 13'] } },
      { label: 'android', browser: ctx.browser, device: { ...devices['Pixel 7'] } },
    ];
    if (iphoneBrowser === ctx.browser) delete (targets[0]!.device as { defaultBrowserType?: string }).defaultBrowserType;
    for (const t of targets) {
      for (const page of pages) {
        const m = await measure(t.browser, ctx, page, `device-${t.label}`, t.device);
        add('mobile-screenshot', page, `${t.label === 'iphone' ? 'iPhone 13' : 'Pixel 7'}${t.browser === ctx.browser && t.label === 'iphone' ? '（Chromiumで代用）' : ''}${m.overflow ? '：横スクロールあり' : ''}`, undefined, m.shot);
      }
    }
  } finally {
    for (const e of engines) await e.browser.close();
  }
}
