/**
 * 標準：表示モード
 * ダークモード（コントラスト・背景色と文字色の指定）、ブラウザの文字サイズ設定（200%）、テキスト間隔（WCAG 1.4.12）
 * フル：強制ダーク（Android Chromeなど）のスクリーンショット
 */
import type { Page } from 'playwright';
import { add, bumpPass, check, registerDefs } from '../lib/core.js';
import { gotoPage, launchChromium, newSafeContext, probe, saveShot, scrollThrough } from '../lib/browser.js';
import type { DeepCtx } from '../lib/browser.js';

registerDefs({
  'dark-contrast': {
    severity: 'fix',
    title: 'ダークモードで文字が読めなくなる',
    why: 'OSをダークモードにすると、文字色と背景色の差がほとんどなくなる箇所がある（ライトモードでは問題ない）。',
    fix: 'prefers-color-scheme: dark の中で文字色だけ変えている場合は、背景色もセットで指定する。ダーク非対応にするなら、その指定自体を外して color-scheme: light を指定する。',
    wcag: '1.4.3',
  },
  'color-pair': {
    severity: 'fix',
    title: '背景色と文字色の片方しか指定していない',
    why: 'Android Chrome の強制ダークや、ブラウザ・拡張機能の配色変更で、背景だけ黒になり文字が黒のまま読めなくなることがある。',
    fix: 'html か body に、背景色（background-color）と文字色（color）を必ずセットで指定する。',
  },
  'dark-unsupported': {
    severity: 'decide',
    title: 'ダークモードに対応しておらず、ライト専用の指定（color-scheme）もない',
    why: 'ダークモードの利用者に対して、ブラウザ任せの表示になる。対応するかは案件次第。',
    fix: 'ダークモードに対応しないなら <meta name="color-scheme" content="light"> を入れる。対応するなら prefers-color-scheme: dark で背景色と文字色をセットで指定する。',
  },
  'dark-screenshot': {
    severity: 'review',
    title: 'ダークモードの見た目（スクリーンショット）',
    why: '透過PNGの黒いロゴが黒背景に溶けるなど、画像の見え方は自動では判定できない。',
    fix: 'スクリーンショットを見て、ロゴ・アイコン・図版が見えるか確認する。',
  },
  'forced-dark-screenshot': {
    severity: 'review',
    title: '強制ダーク（Android Chromeなど）での見た目（スクリーンショット）',
    why: 'サイトが未対応でも、ブラウザが配色を自動で変換することがある。変換の結果は自動では判定できない。',
    fix: 'スクリーンショットを見て、文字や画像が読めるか確認する。実機（Android Chrome の「ウェブコンテンツのダークモード」）でも確認する。',
  },
  'font-px-fixed': {
    severity: 'decide',
    title: 'ブラウザの文字サイズ設定が効かない（文字サイズがpxで固定）',
    why: '文字を大きくして読んでいる人が、このサイトでは大きくできない。ページの拡大（ズーム）は効く。',
    fix: 'html の font-size を px で指定せず、%（例：62.5%）や rem・em で文字サイズを指定する。',
    wcag: '1.4.4',
  },
  'textzoom-overflow': {
    severity: 'fix',
    title: '文字サイズを200%にすると横スクロールが出る',
    why: 'ブラウザの文字サイズを大きくして使っている人の画面で、レイアウトが崩れる。',
    fix: '固定幅・固定高さの要素を、文字の大きさに合わせて伸びる指定（min-height、max-width、%）にする。',
    wcag: '1.4.4',
  },
  'textzoom-clipped': {
    severity: 'fix',
    title: '文字サイズを200%にするとテキストが切れる',
    why: 'ブラウザの文字サイズを大きくしたときに、文字が枠からはみ出して読めなくなる。',
    fix: '固定の height を min-height にする、overflow: hidden を外すなど。',
    wcag: '1.4.4',
  },
  'textzoom-header': {
    severity: 'decide',
    title: '文字サイズを200%にすると固定ヘッダーが画面の多くを占める',
    why: '本文を読める範囲が狭くなる。',
    fix: 'ヘッダーの高さを文字サイズに比例させない、スマホでは固定をやめるなどを検討する。',
  },
  'text-spacing-clipped': {
    severity: 'review',
    title: '行間・文字間を広げるとテキストが切れる',
    why: '読みやすさのために行間や文字間を広げている人の環境で、文字が隠れる。',
    fix: '固定の高さを避け、文字量に応じて伸びるレイアウトにする。',
    wcag: '1.4.12',
  },
});

interface ContrastItem {
  i: number;
  desc: string;
  ratio: number;
  fg: string;
  bg: string;
}

const TEXT_SPACING_CSS = `* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }`;

async function overflowAndClip(pw: Page): Promise<{ overflow: boolean; sw: number; clipped: string[] }> {
  const o = await probe<{ overflow: boolean; sw: number }>(pw, 'overflow');
  const c = await probe<string[]>(pw, 'clipped');
  return { overflow: o.overflow, sw: o.sw, clipped: c };
}

export async function runDisplayModes(ctx: DeepCtx): Promise<void> {
  const { opts } = ctx;
  let anyDarkSupport = false;
  let anyColorScheme = false;
  const pagesNoDark: string[] = [];

  // ---------- ダークモード ----------
  const light = await newSafeContext(ctx.browser, { colorScheme: 'light' });
  const dark = await newSafeContext(ctx.browser, { colorScheme: 'dark' });
  const lp = await light.newPage();
  const dp = await dark.newPage();
  try {
    for (const page of ctx.pages) {
      await gotoPage(lp, opts, page);
      await gotoPage(dp, opts, page);
      await lp.waitForTimeout(300);
      await dp.waitForTimeout(300);

      const decl = await probe<{ color: boolean; background: boolean; darkMedia: boolean; colorScheme: string }>(lp, 'colorDecl');
      if (decl.darkMedia) anyDarkSupport = true;
      if (/light|dark/.test(decl.colorScheme)) anyColorScheme = true;
      if (!decl.darkMedia) pagesNoDark.push(page);
      check('color-pair', page, decl.color !== decl.background ? [decl.color ? '文字色だけ指定され、背景色がない（html / body）' : '背景色だけ指定され、文字色がない（html / body）'] : []);

      const lc = await probe<ContrastItem[]>(lp, 'contrast');
      const dc = await probe<ContrastItem[]>(dp, 'contrast');
      const lightMap = new Map(lc.map((c) => [c.i, c]));
      const bad = dc.filter((d) => d.ratio < 3 && (lightMap.get(d.i)?.ratio ?? 0) >= 3);
      let darkShot: string | undefined;
      if (decl.darkMedia || bad.length > 0) darkShot = await saveShot(dp, opts, page, 'dark');
      if (bad.length > 0) {
        for (const b of bad.slice(0, 4)) add('dark-contrast', page, `${b.desc}：コントラスト比 ${b.ratio}（文字 ${b.fg} / 背景 ${b.bg}）`, undefined, darkShot);
      } else bumpPass();
      if (decl.darkMedia && darkShot) add('dark-screenshot', page, 'ダークモードで表示', undefined, darkShot);
    }
  } finally {
    await light.close();
    await dark.close();
  }
  if (!anyDarkSupport && !anyColorScheme) add('dark-unsupported', pagesNoDark.slice(0, 3).join(', '), 'prefers-color-scheme と color-scheme の指定が見つからない');
  else bumpPass();

  // ---------- 強制ダーク（フルのみ） ----------
  if (opts.profile === 'full') {
    // Android Chrome の「ウェブコンテンツのダークモード」と同じ、Blinkの強制ダークを有効にする
    const fb = await launchChromium(['--blink-settings=forceDarkModeEnabled=true']);
    if (fb) {
      try {
        const fc = await newSafeContext(fb, { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
        const fp = await fc.newPage();
        for (const page of ctx.pages.slice(0, 3)) {
          await gotoPage(fp, opts, page);
          const f = await saveShot(fp, opts, page, 'forced-dark', false);
          if (f) add('forced-dark-screenshot', page, '強制ダーク（Chromiumの機能で再現）', undefined, f);
        }
        await fc.close();
      } finally {
        await fb.close();
      }
    }
  }

  // ---------- 文字サイズ200%・テキスト間隔 ----------
  const bc = await newSafeContext(ctx.browser);
  const pw = await bc.newPage();
  const cdp = await bc.newCDPSession(pw);
  await cdp.send('Page.enable');
  const pxFixedPages: string[] = [];
  try {
    for (const page of ctx.pages) {
      // 通常の文字サイズで基準を取る
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: 16, fixed: 13 } });
      await pw.setViewportSize({ width: 375, height: 800 });
      await gotoPage(pw, opts, page);
      await scrollThrough(pw);
      const base = await probe<Array<{ i: number; fs: number }>>(pw, 'fontSample');
      const baseClip = new Set((await probe<string[]>(pw, 'clipped')).map((s) => s));
      const baseOverflow = (await probe<{ overflow: boolean }>(pw, 'overflow')).overflow;

      // ブラウザの文字サイズ設定を200%（16px→32px）にする
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: 32, fixed: 26 } });
      await gotoPage(pw, opts, page);
      await scrollThrough(pw);
      const big = await probe<Array<{ i: number; fs: number }>>(pw, 'fontSample');
      const bigMap = new Map(big.map((b) => [b.i, b.fs]));
      const compared = base.filter((b) => bigMap.has(b.i));
      const grown = compared.filter((b) => (bigMap.get(b.i) ?? 0) > b.fs * 1.3).length;
      const pxFixed = compared.length >= 5 && grown / compared.length < 0.2;
      if (pxFixed) pxFixedPages.push(page);
      else {
        // 文字が大きくなるサイトだけ、崩れを確認する
        let shot: string | undefined;
        for (const w of [375, 1440]) {
          await pw.setViewportSize({ width: w, height: 800 });
          await pw.waitForTimeout(300);
          const r = await overflowAndClip(pw);
          const newClip = r.clipped.filter((c) => !baseClip.has(c));
          if ((r.overflow && !(w === 375 && baseOverflow)) || newClip.length > 0) shot = shot ?? (await saveShot(pw, opts, page, `textzoom-${w}`, false));
          if (r.overflow && !(w === 375 && baseOverflow)) add('textzoom-overflow', page, `${w}px：ページ幅${r.sw}px`, undefined, shot);
          else bumpPass();
          if (newClip.length > 0) for (const c of newClip.slice(0, 3)) add('textzoom-clipped', page, `${w}px：${c}`, undefined, shot);
          else bumpPass();
          if (w === 375) {
            const ft = await probe<{ ratio: number; px: number }>(pw, 'fixedTop');
            check('textzoom-header', page, ft.ratio > 0.35 ? [`375×800で画面の${Math.round(ft.ratio * 100)}%（${ft.px}px）`] : []);
          }
        }
      }

      // テキスト間隔（WCAG 1.4.12）
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: 16, fixed: 13 } });
      await pw.setViewportSize({ width: 1440, height: 900 });
      await gotoPage(pw, opts, page);
      const before = new Set(await probe<string[]>(pw, 'clipped'));
      await pw.addStyleTag({ content: TEXT_SPACING_CSS }).catch(() => pw.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(TEXT_SPACING_CSS)}; document.head.appendChild(s); })()`));
      await pw.waitForTimeout(300);
      const after = (await probe<string[]>(pw, 'clipped')).filter((c) => !before.has(c));
      if (after.length > 0) {
        const shot = await saveShot(pw, opts, page, 'text-spacing', false);
        for (const c of after.slice(0, 3)) add('text-spacing-clipped', page, c, undefined, shot);
      } else bumpPass();
    }
  } finally {
    await bc.close();
  }
  if (pxFixedPages.length > 0) add('font-px-fixed', pxFixedPages.slice(0, 3).join(', '), '文字サイズを200%にしても、本文の文字サイズが変わらない');
  else bumpPass();
}
