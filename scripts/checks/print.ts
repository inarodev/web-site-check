/**
 * フル：印刷
 * 印刷用CSSの有無、印刷時に残る固定要素、右端の切れ、PDF化した見た目（目視用）
 */
import { mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { add, bumpPass, check, registerDefs, slug } from '../lib/core.js';
import { gotoPage, newSafeContext, probe, scrollThrough } from '../lib/browser.js';
import type { DeepCtx } from '../lib/browser.js';

registerDefs({
  'print-css-missing': {
    severity: 'decide',
    title: '印刷用のCSS（@media print）がない',
    why: '印刷すると、ナビゲーション・固定ヘッダー・フォームなどもそのまま印刷される。印刷される想定がなければ対応不要。',
    fix: '会社案内・地図・申込書など印刷されそうなページがあれば、@media print で不要な要素を隠し、文字色・背景を調整する。',
  },
  'print-fixed': {
    severity: 'decide',
    title: '印刷時に、固定ヘッダーやバナーが残る',
    why: 'position: fixed の要素は、印刷すると各ページに重なって出ることがあり、本文が隠れる。',
    fix: '@media print で position: static にするか、display: none にする。',
  },
  'print-overflow': {
    severity: 'decide',
    title: '印刷すると右端が切れる可能性がある',
    why: '用紙の幅（A4で約800px）より広い要素がある。',
    fix: '@media print で固定幅の要素を width: auto や max-width: 100% にする。',
  },
  'print-pdf': {
    severity: 'review',
    title: '印刷イメージ（PDF）',
    why: '改ページの位置や、見出しだけが前のページに残るなどは、自動では判定できない。',
    fix: 'PDFを開いて、印刷したときに読みやすいか確認する。',
  },
});

export async function runPrint(ctx: DeepCtx): Promise<void> {
  const { opts } = ctx;
  const bc = await newSafeContext(ctx.browser, { viewport: { width: 1280, height: 900 } });
  const pw = await bc.newPage();
  const noPrintCss: string[] = [];
  await mkdir(path.join(opts.out, 'print'), { recursive: true });
  try {
    for (const page of ctx.pages) {
      await gotoPage(pw, opts, page);
      await scrollThrough(pw);
      await pw.emulateMedia({ media: 'print' });
      await pw.setViewportSize({ width: 794, height: 1123 });
      await pw.waitForTimeout(300);
      const info = await probe<{ printRules: boolean; fixed: string[]; nav: string[]; width: number }>(pw, 'printInfo');
      if (!info.printRules) noPrintCss.push(page);
      check('print-fixed', page, info.fixed.slice(0, 3));
      check('print-overflow', page, info.width > 820 ? [`印刷時のページ幅 ${info.width}px`] : []);

      const rel = path.join('print', `${slug(page)}.pdf`);
      try {
        await pw.pdf({ path: path.join(opts.out, rel), format: 'A4', printBackground: true });
        const buf = await readFile(path.join(opts.out, rel));
        const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
        add('print-pdf', page, `A4で${pages}ページ${info.printRules ? '' : '（印刷用CSSなし）'}`, undefined, rel);
      } catch {
        bumpPass(0);
      }
      await pw.emulateMedia({ media: 'screen' });
      await pw.setViewportSize({ width: 1280, height: 900 });
    }
  } finally {
    await bc.close();
  }
  if (noPrintCss.length === ctx.pages.length && noPrintCss.length > 0) add('print-css-missing', noPrintCss.slice(0, 3).join(', '), '検査したどのページにも @media print の指定がない');
  else if (noPrintCss.length > 0) add('print-css-missing', noPrintCss.slice(0, 3).join(', '), '一部のページに @media print の指定がない');
  else bumpPass();
}
