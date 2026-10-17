/**
 * フル：回線・外部要因
 * 低速回線での読み込み、外部サービス（CDN・計測タグ・Webフォントなど）が失敗したときの表示、
 * font-display、動きを減らす設定（prefers-reduced-motion）への対応
 */
import { add, bumpPass, check, fetchText, registerDefs, snippet } from '../lib/core.js';
import { gotoPage, newSafeContext, probe, saveShot } from '../lib/browser.js';
import type { DeepCtx } from '../lib/browser.js';

registerDefs({
  'slow-network': {
    severity: 'review',
    title: '低速回線での読み込み（参考値）',
    why: 'モバイル回線（約1.6Mbps・遅延150ms・CPU 4倍遅延）を想定した値。ローカル環境なので本番とは異なる。',
    fix: '時間がかかる場合は、画像の圧縮・遅延読み込み、不要なスクリプトの削減を検討する。',
  },
  'slow-network-heavy': {
    severity: 'decide',
    title: '低速回線だと表示に時間がかかる、またはレイアウトがずれる',
    why: 'メインの表示（LCP）が4秒以上、読み込み完了が15秒以上、またはレイアウトのずれ（CLS）が0.1以上。',
    fix: 'ファーストビューの画像を軽くする、画像に width/height を付ける、Webフォントや広告の読み込み方を見直す。',
  },
  'thirdparty-fail': {
    severity: 'fix',
    title: '外部サービスの読み込みに失敗すると、表示が崩れる・見えなくなる',
    why: 'CDN・計測タグ・Webフォントなどが落ちたり、広告ブロッカーで止められたりしたとき、本文が見えない、ローディング画面が残るなどの状態になる。',
    fix: '外部のスクリプトやCSSに頼らず、最低限の表示ができる作りにする。ローディング画面はJSに頼らず消える仕組みにする。',
  },
  'font-display-missing': {
    severity: 'decide',
    title: 'Webフォントに font-display の指定がない',
    why: 'フォントの読み込みが遅いと、最大3秒ほど文字が見えなくなる場合がある。',
    fix: '@font-face に font-display: swap を付ける。Google Fonts なら URL に &display=swap を付ける。',
  },
  'reduced-motion-missing': {
    severity: 'decide',
    title: '動きを減らす設定（prefers-reduced-motion）に対応していない',
    why: 'OSで「視差効果を減らす」「アニメーションを減らす」を設定している人にも、アニメーションがそのまま表示される。動きで気分が悪くなる人がいる。',
    fix: '@media (prefers-reduced-motion: reduce) でアニメーションを止める。GSAPなら gsap.matchMedia() で分岐する。',
    wcag: '2.3.3',
  },
});

interface Perf {
  load: number;
  lcp: number;
  cls: number;
  bytes: number;
}

export async function runNetwork(ctx: DeepCtx): Promise<void> {
  const { opts } = ctx;

  // ---------- 低速回線 ----------
  {
    const bc = await newSafeContext(ctx.browser, { viewport: { width: 390, height: 844 }, isMobile: true });
    const pw = await bc.newPage();
    const cdp = await bc.newCDPSession(pw);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    try {
      for (const page of ctx.pages.slice(0, 3)) {
        await pw.goto(new URL(page, opts.base).href, { waitUntil: 'load', timeout: 90000 }).catch(() => undefined);
        const p = await probe<Perf>(pw, 'perf');
        const line = `読み込み完了 ${(p.load / 1000).toFixed(1)}秒 / LCP ${(p.lcp / 1000).toFixed(1)}秒 / CLS ${p.cls} / 転送量 ${Math.round(p.bytes / 1024)}KB`;
        add('slow-network', page, line);
        const heavy: string[] = [];
        if (p.lcp >= 4000) heavy.push(`LCP ${(p.lcp / 1000).toFixed(1)}秒`);
        if (p.load >= 15000) heavy.push(`読み込み完了 ${(p.load / 1000).toFixed(1)}秒`);
        if (p.cls >= 0.1) heavy.push(`CLS ${p.cls}`);
        check('slow-network-heavy', page, heavy.length ? [heavy.join('、')] : []);
      }
    } finally {
      await bc.close();
    }
  }

  // ---------- 外部サービスの失敗 ----------
  {
    const bc = await newSafeContext(ctx.browser, { viewport: { width: 1440, height: 900 } });
    let blocked = 0;
    await bc.route('**/*', (route) => {
      const u = route.request().url();
      if (/^https?:/.test(u) && new URL(u).origin !== opts.base.origin) {
        blocked++;
        return route.abort('failed');
      }
      return route.fallback();
    });
    const pw = await bc.newPage();
    try {
      for (const page of ctx.pages) {
        const b0 = blocked;
        await gotoPage(pw, opts, page).catch(() => undefined);
        await pw.waitForTimeout(3000);
        if (blocked === b0) {
          bumpPass();
          continue;
        }
        const overlays = await probe<string[]>(pw, 'overlays');
        const hidden = await probe<{ total: number; hidden: number; items: string[] }>(pw, 'hiddenContent');
        const problems = [...overlays.map((o) => `ローディング画面が残る：${o}`), ...(hidden.total > 0 && hidden.hidden / hidden.total >= 0.05 ? hidden.items.slice(0, 2).map((i) => `透明・非表示のまま：${i}`) : [])];
        if (problems.length > 0) {
          const shot = await saveShot(pw, opts, page, 'thirdparty-fail', false);
          for (const p of problems) add('thirdparty-fail', page, `外部リクエスト${blocked - b0}件を失敗させたとき：${p}`, undefined, shot);
        } else bumpPass();
      }
    } finally {
      await bc.close();
    }
  }

  // ---------- font-display・動きの抑制 ----------
  {
    const bc = await newSafeContext(ctx.browser, { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const pw = await bc.newPage();
    const scriptTexts: string[] = [];
    pw.on('response', async (r) => {
      if (r.request().resourceType() !== 'script') return;
      try {
        const t = await r.text();
        if (t.length < 3_000_000) scriptTexts.push(t);
      } catch {
        /* 無視 */
      }
    });
    const fontMissing = new Set<string>();
    const motionPages: string[] = [];
    try {
      for (const page of ctx.pages) {
        scriptTexts.length = 0;
        await gotoPage(pw, opts, page);
        await pw.waitForTimeout(800);
        const ff = await probe<{ missing: string[]; cross: string[] }>(pw, 'fontFaces');
        for (const m of ff.missing) fontMissing.add(m);
        for (const href of ff.cross.slice(0, 5)) {
          if (/fonts\.googleapis\.com/.test(href)) {
            if (!/[?&]display=/.test(href)) fontMissing.add(`Google Fonts（${snippet(href, 60)}）`);
            continue;
          }
          const css = await fetchText(href);
          if (!css || css.status !== 200) continue;
          for (const block of css.body.match(/@font-face\s*{[^}]*}/g) ?? []) {
            if (!/font-display/.test(block)) fontMissing.add(`${(block.match(/font-family:\s*([^;]+)/)?.[1] ?? '?').replace(/["']/g, '')}（${snippet(href, 50)}）`);
          }
        }
        const m = await probe<{ keyframes: number; reducedCss: boolean; running: number; gsap: boolean; scrollTrigger: boolean }>(pw, 'motion');
        const inlineHas = await pw.evaluate(`Array.from(document.scripts).some((s) => /prefers-reduced-motion/.test(s.textContent || ''))`);
        const jsHas = scriptTexts.some((t) => t.includes('prefers-reduced-motion') || t.includes('reducedMotion'));
        const animated = m.running > 0 || m.gsap || m.scrollTrigger;
        if (animated && !m.reducedCss && !inlineHas && !jsHas) motionPages.push(`${page}（動作中のアニメーション${m.running}件${m.gsap ? '、GSAPあり' : ''}）`);
      }
    } finally {
      await bc.close();
    }
    if (fontMissing.size > 0) for (const f of [...fontMissing].slice(0, 5)) add('font-display-missing', '-', f);
    else bumpPass();
    if (motionPages.length > 0) for (const p of motionPages.slice(0, 3)) add('reduced-motion-missing', p.split('（')[0]!, p);
    else bumpPass();
  }
}
