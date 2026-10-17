/**
 * 標準：レイアウト
 * 横スクロール・はみ出し（320〜1440px）、テキストの切れ、文字サイズ、100vh、タップ領域、固定ヘッダーの占有
 */
import { add, bumpPass, check, registerDefs } from '../lib/core.js';
import { gotoPage, newSafeContext, probe, saveShot, scrollThrough } from '../lib/browser.js';
import type { DeepCtx } from '../lib/browser.js';

registerDefs({
  'layout-overflow': {
    severity: 'fix',
    title: '横スクロールが発生する画面幅がある',
    why: 'スマホなどで横に揺れたり、右端が見切れたりする。ブラウザで200%〜400%に拡大したときも同じ状態になる。',
    fix: '指摘された要素の固定幅（width）を max-width や % に変える、画像に max-width: 100% を付ける、長い英数字に overflow-wrap: anywhere を付けるなど。',
    wcag: '1.4.10',
  },
  'layout-overflow-hidden': {
    severity: 'decide',
    title: 'はみ出しを overflow-x: hidden で隠している',
    why: '横スクロールは出ないが、はみ出した部分が見えなくなっている。意図したトリミングなら対応不要。',
    fix: 'はみ出している要素の幅を直し、隠す指定に頼らないようにする。',
    wcag: '1.4.10',
  },
  'text-clipped': {
    severity: 'review',
    title: 'テキストが枠に収まらず切れている可能性がある',
    why: '高さや幅を固定した箱に overflow: hidden が付いていて、中の文字が収まっていない。意図した省略なら対応不要。',
    fix: '固定の height を min-height にする、または省略表示なら text-overflow: ellipsis や line-clamp を使う。',
    wcag: '1.4.4',
  },
  'font-too-small': {
    severity: 'fix',
    title: '本文の文字が10px以下になっている',
    why: '読めない、または非常に読みにくい。',
    fix: '本文は14〜16px以上を目安にする。',
  },
  'font-small-supp': {
    severity: 'decide',
    title: '注釈・キャプションなどの文字が10px以下になっている',
    why: '補足の文字でも、10px以下は読みにくい。デザイン上の意図があるか確認が必要。',
    fix: '補足でも11〜12px以上を目安にする。',
  },
  'font-small-body': {
    severity: 'review',
    title: '本文の文字が11〜13pxと小さめ',
    why: 'スマホでは読みにくい場合がある。デザインによっては許容範囲。',
    fix: 'スマホの本文は14〜16pxを目安に見直す。',
  },
  'font-small-ratio': {
    severity: 'fix',
    title: 'ページの文字の多くが12px未満になっている',
    why: 'Lighthouse の「読みやすいフォントサイズ」では、12px未満の文字が60%を超えると不合格になる。',
    fix: '本文の文字サイズを全体的に見直す。',
  },
  'vh-100': {
    severity: 'decide',
    title: '100vh を使っていて、dvh/svh の指定がない',
    why: 'iOS Safari や LINE などのアプリ内ブラウザでは、アドレスバーの表示によって下端が見切れることがある。',
    fix: 'height: 100vh; の後に height: 100svh;（または 100dvh）を書いて上書きする。',
  },
  'tap-target-small': {
    severity: 'decide',
    title: 'タップしにくい小さなボタン・リンクがある（24px未満）',
    why: 'スマホで押し間違えやすい。',
    fix: 'タップ領域を24×24px以上（推奨は44×44px）にする。見た目を変えたくなければ padding で広げる。',
    wcag: '2.5.8',
  },
  'img-lazy-above-fold': {
    severity: 'decide',
    title: '最初に見える位置の画像に loading="lazy" が付いている',
    why: 'ファーストビューの画像の表示が遅れ、LCP（メインの表示までの時間）が悪くなる。',
    fix: 'ファーストビューの画像からは loading="lazy" を外す。メインビジュアルなら fetchpriority="high" も検討する。',
  },
  'img-lazy-missing': {
    severity: 'decide',
    title: 'スクロールしないと見えない画像に loading="lazy" がない',
    why: '最初の表示に不要な画像まで一度に読み込み、表示が遅くなる。',
    fix: 'ファーストビューより下の画像に loading="lazy" を付ける。',
  },
  'img-no-srcset': {
    severity: 'decide',
    title: '大きく表示する画像に srcset がない',
    why: 'スマホでもPC用の大きな画像を読み込む。',
    fix: 'srcset と sizes で画面幅に合った画像を出し分ける。Next.js・Astro なら Image コンポーネントを使う。',
  },
  'bg-image-oversize': {
    severity: 'decide',
    title: '背景画像の実寸が、表示サイズより大きすぎる（3倍超）',
    why: '表示に不要なピクセルを読み込んでいる。メインビジュアルなど意図して大きい場合もある。',
    fix: '表示サイズの2倍程度にリサイズし、image-set() や メディアクエリでスマホ用を出し分ける。',
  },
  'header-covers-content': {
    severity: 'fix',
    title: '固定ヘッダーの下に、見出しや本文が隠れている',
    why: 'ページを開いた直後の状態で、position: fixed のヘッダーが見出しや本文の上に重なっている。',
    fix: 'body か main に、ヘッダーの高さ分の padding-top を付ける。ページごとの余白に頼っている場合は、共通のレイアウトで確保する。',
  },
  'anchor-under-header': {
    severity: 'decide',
    title: 'ページ内リンクで移動すると、移動先の見出しが固定ヘッダーに隠れる可能性がある',
    why: '移動先の要素に scroll-margin-top がなく、html にも scroll-padding-top がない。',
    fix: 'html { scroll-padding-top: ヘッダーの高さ; } を指定する。',
  },
  'fixed-header-large': {
    severity: 'decide',
    title: '固定ヘッダーが画面の多くを占めている',
    why: 'スマホの横向きや文字拡大時に、本文の表示領域が狭くなる。',
    fix: 'スクロールでヘッダーを縮める、スマホでは固定をやめる、高さを抑えるなどを検討する。',
  },
});

interface OverflowRes {
  vw: number;
  sw: number;
  overflow: boolean;
  hiddenX: boolean;
  offenders: string[];
}
interface FontsRes {
  small: Array<{ desc: string; fs: number; kind: 'body' | 'supp' | 'other' }>;
  total: number;
  under12: number;
}

const WIDTHS = [320, 375, 640, 768, 1024, 1440];

export async function runLayout(ctx: DeepCtx): Promise<void> {
  const { opts } = ctx;
  const bc = await newSafeContext(ctx.browser);
  const pw = await bc.newPage();
  try {
    for (const page of ctx.pages) {
      await pw.setViewportSize({ width: 1440, height: 900 });
      await gotoPage(pw, opts, page);
      await scrollThrough(pw);

      const overflowAt: Array<{ msg: string; shot?: string }> = [];
      const hiddenAt: string[] = [];
      const clipped = new Set<string>();
      for (const w of WIDTHS) {
        await pw.setViewportSize({ width: w, height: w < 768 ? 800 : 900 });
        await pw.waitForTimeout(350);
        const o = await probe<OverflowRes>(pw, 'overflow');
        if (o.overflow) {
          // 証跡は幅ごとに撮る（最初の3つまで）
          const shot = overflowAt.length < 3 ? await saveShot(pw, opts, page, `overflow-${w}`, false) : undefined;
          overflowAt.push({ msg: `${w}px：ページ幅${o.sw}px${o.offenders.length ? `、原因の候補 ${o.offenders.slice(0, 3).join(' / ')}` : ''}`, shot });
        } else if (o.hiddenX && o.offenders.length > 0) {
          hiddenAt.push(`${w}px：${o.offenders.slice(0, 3).join(' / ')}`);
        }
        if (w === 375 || w === 1440) for (const c of await probe<string[]>(pw, 'clipped')) clipped.add(`${w}px：${c}`);
      }
      if (overflowAt.length > 0) for (const o of overflowAt.slice(0, 4)) add('layout-overflow', page, o.msg, undefined, o.shot);
      else bumpPass();
      check('layout-overflow-hidden', page, hiddenAt.slice(0, 3));
      check('text-clipped', page, [...clipped].slice(0, 5));

      // 文字サイズ（スマホ幅とPC幅）
      const tooSmall = new Set<string>();
      const suppSmall = new Set<string>();
      const bodySmall = new Set<string>();
      let ratioMsg: string | undefined;
      for (const w of [375, 1440]) {
        await pw.setViewportSize({ width: w, height: 900 });
        await pw.waitForTimeout(250);
        const f = await probe<FontsRes>(pw, 'fonts');
        for (const s of f.small) {
          const line = `${w}px：${s.desc}（${s.fs}px）`;
          if (s.fs <= 10 && s.kind === 'supp') suppSmall.add(line);
          else if (s.fs <= 10) tooSmall.add(line);
          else if (s.kind === 'body' && s.fs < 14 && s.fs >= 11) bodySmall.add(line);
        }
        if (f.total > 200 && f.under12 / f.total >= 0.6) ratioMsg = `${w}px：12px未満の文字が${Math.round((f.under12 / f.total) * 100)}%`;
      }
      check('font-too-small', page, [...tooSmall].slice(0, 5));
      check('font-small-supp', page, [...suppSmall].slice(0, 5));
      check('font-small-body', page, [...bodySmall].slice(0, 5));
      check('font-small-ratio', page, ratioMsg ? [ratioMsg] : []);

      // 画像の読み込み方（PC幅で見る）
      await pw.setViewportSize({ width: 1440, height: 900 });
      await pw.evaluate('window.scrollTo(0, 0)');
      await pw.waitForTimeout(250);
      const ie = await probe<{ lazyAbove: string[]; eagerBelow: string[]; noSrcset: string[]; bgOversize: string[] }>(pw, 'imagesExtra');
      check('img-lazy-above-fold', page, ie.lazyAbove);
      check('img-lazy-missing', page, ie.eagerBelow.length >= 3 ? [`${ie.eagerBelow.length}枚（例：${ie.eagerBelow.slice(0, 3).join(' / ')}）`] : []);
      check('img-no-srcset', page, ie.noSrcset);
      check('bg-image-oversize', page, ie.bgOversize);

      // 100vh
      check('vh-100', page, await probe<string[]>(pw, 'vh100'));

      // タップ領域と固定ヘッダー（スマホ幅）
      await pw.setViewportSize({ width: 375, height: 667 });
      await pw.waitForTimeout(250);
      check('tap-target-small', page, (await probe<string[]>(pw, 'tapTargets')).slice(0, 6));
      const ft = await probe<{ ratio: number; px: number; els: string[] }>(pw, 'fixedTop');
      await pw.setViewportSize({ width: 667, height: 375 });
      await pw.waitForTimeout(250);
      const ftLand = await probe<{ ratio: number; px: number; els: string[] }>(pw, 'fixedTop');
      const ftMsgs: string[] = [];
      if (ft.ratio > 0.25) ftMsgs.push(`縦向き375×667で画面の${Math.round(ft.ratio * 100)}%（${ft.px}px）：${ft.els.join(' / ')}`);
      if (ftLand.ratio > 0.35) ftMsgs.push(`横向き667×375で画面の${Math.round(ftLand.ratio * 100)}%（${ftLand.px}px）：${ftLand.els.join(' / ')}`);
      check('fixed-header-large', page, ftMsgs);

      // 固定ヘッダーに見出しや本文が隠れていないか、ページ内リンクの移動先が隠れないか
      const covered = new Set<string>();
      const anchors = new Set<string>();
      const coverShots = new Map<number, string | undefined>();
      for (const w of [1440, 375]) {
        await pw.setViewportSize({ width: w, height: w < 768 ? 800 : 900 });
        await pw.evaluate('window.scrollTo(0, 0)');
        await pw.waitForTimeout(300);
        const hc = await probe<{ covered: string[]; anchors: string[] }>(pw, 'headerCovers');
        if (hc.covered.length > 0) coverShots.set(w, await saveShot(pw, opts, page, `header-covers-${w}`, false));
        for (const c of hc.covered) covered.add(`${w}px：${c}`);
        for (const a of hc.anchors) anchors.add(a);
      }
      if (covered.size > 0) for (const c of [...covered].slice(0, 3)) add('header-covers-content', page, c, undefined, coverShots.get(Number(c.split('px')[0])));
      else bumpPass();
      check('anchor-under-header', page, [...anchors].slice(0, 3));
    }
  } finally {
    await bc.close();
  }
}
