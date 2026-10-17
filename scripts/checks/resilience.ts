/**
 * 標準：JavaScriptが動かないときの表示
 * 1) JavaScript無効  2) JSファイルの読み込みに失敗（JSは有効）
 * どちらも「本文が透明なまま」「ローディング画面が残る」を検出する。
 */
import type { BrowserContextOptions, Page } from 'playwright';
import { add, bumpPass, registerDefs } from '../lib/core.js';
import { gotoPage, newSafeContext, probe, saveShot } from '../lib/browser.js';
import type { DeepCtx } from '../lib/browser.js';

registerDefs({
  'nojs-hidden-content': {
    severity: 'fix',
    title: 'JavaScriptが動かないと本文が見えない',
    why: 'フェードイン用の opacity: 0 などをJSで外す作りのため、JSが無効・エラーで止まった環境では文字が透明のまま残る。',
    fix: '初期状態は表示しておき、JSが動いたときだけ隠す（例：<html class="js"> を付けてから .js .fade { opacity: 0 } にする）。<noscript> で表示用のCSSを読み込む方法もある。',
  },
  'nojs-overlay': {
    severity: 'fix',
    title: 'JavaScriptが動かないとローディング画面が消えない',
    why: 'JSでローディング画面を消す作りのため、JSが無効・エラーで止まると、画面全体が覆われたままになる。',
    fix: 'ローディング画面をJSで追加する、CSSアニメーションで数秒後に自動で消す、<noscript> で非表示にするなど、JSなしでも消える仕組みにする。',
  },
  'jsfail-hidden-content': {
    severity: 'fix',
    title: 'JSファイルの読み込みに失敗すると本文が見えない',
    why: '通信エラーや広告ブロッカーでJSが読み込めなかったとき、文字が透明のまま残る。',
    fix: '初期状態は表示しておき、JSが動いたときだけ隠す作りにする。',
  },
  'jsfail-overlay': {
    severity: 'fix',
    title: 'JSファイルの読み込みに失敗するとローディング画面が消えない',
    why: '通信エラーや広告ブロッカーでJSが読み込めなかったとき、画面全体が覆われたままになる（noscriptは働かない）。',
    fix: 'CSSアニメーションで数秒後に自動で消すなど、JSに頼らない仕組みにする。',
  },
});

interface Hidden {
  total: number;
  hidden: number;
  items: string[];
}

async function evaluateScenario(pw: Page, ctx: DeepCtx, page: string, scenario: 'nojs' | 'jsfail'): Promise<void> {
  const { opts } = ctx;
  await gotoPage(pw, opts, page).catch(() => undefined);
  await pw.waitForTimeout(4000); // CSSアニメーションで自動的に消える作りなら、ここで消える
  const overlays = await probe<string[]>(pw, 'overlays');
  const hidden = await probe<Hidden>(pw, 'hiddenContent');
  let shot: string | undefined;
  const hiddenBad = hidden.items.length > 0 && hidden.total > 0 && hidden.hidden / hidden.total >= 0.05;
  if (overlays.length > 0 || hiddenBad) shot = await saveShot(pw, opts, page, scenario, false);
  if (overlays.length > 0) for (const o of overlays.slice(0, 2)) add(`${scenario}-overlay`, page, `4秒待っても残る：${o}`, undefined, shot);
  else bumpPass();
  if (hiddenBad) {
    const pct = Math.round((hidden.hidden / hidden.total) * 100);
    for (const it of hidden.items.slice(0, 3)) add(`${scenario}-hidden-content`, page, `透明・非表示のまま：${it}（本文の約${pct}%）`, undefined, shot);
  } else bumpPass();
}

export async function runResilience(ctx: DeepCtx): Promise<void> {
  const scenarios: Array<{ name: 'nojs' | 'jsfail'; options: BrowserContextOptions }> = [
    { name: 'nojs', options: { javaScriptEnabled: false } },
    { name: 'jsfail', options: {} },
  ];
  for (const sc of scenarios) {
    const bc = await newSafeContext(ctx.browser, { viewport: { width: 1440, height: 900 }, ...sc.options });
    if (sc.name === 'jsfail') {
      // JSファイルだけ失敗させる（インラインのスクリプトは動く）
      await bc.route('**/*', (route) => (route.request().resourceType() === 'script' ? route.abort('failed') : route.fallback()));
    }
    const pw = await bc.newPage();
    try {
      for (const page of ctx.pages) await evaluateScenario(pw, ctx, page, sc.name);
    } finally {
      await bc.close();
    }
  }
}
