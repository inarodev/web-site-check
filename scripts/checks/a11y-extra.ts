/**
 * 標準：読み上げの追加検査
 * 装飾記号・絵文字、同じ文言で行き先の違うリンク、日本語ページ内の英文、aria-hidden内のリンク、
 * 見た目と読み上げ順のズレ、正のtabindex、アクセシビリティツリーの書き出し
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { add, bumpPass, check, pushFact, registerDefs, slug } from '../lib/core.js';
import { gotoPage, newSafeContext, probe } from '../lib/browser.js';
import type { DeepCtx } from '../lib/browser.js';

registerDefs({
  'sr-symbols': {
    severity: 'decide',
    title: '装飾の記号が読み上げられる可能性がある（★★★☆☆、▶、>> など）',
    why: '「黒い星、黒い星…」「右向き三角」のように記号の名前が読まれる場合がある。',
    fix: '装飾なら記号を CSS（::before）で出すか aria-hidden="true" の span で囲む。評価の星なら「5段階中4」などのテキストを添える。',
    wcag: '1.1.1',
  },
  'sr-emoji': {
    severity: 'decide',
    title: '文中の絵文字が読み上げられる可能性がある',
    why: '「電話の受話器」のように絵文字の名前が読まれる場合がある。装飾なら不要な読み上げになる。',
    fix: '装飾なら <span aria-hidden="true">📞</span> にする。意味があるならそのままでよい。',
    wcag: '1.1.1',
  },
  'sr-same-link-text': {
    severity: 'decide',
    title: '同じ文言で行き先の違うリンクがある',
    why: 'リンク一覧で読み上げたとき、どれがどこへ行くのか区別できない。',
    fix: '文言を変えるか、aria-label で補う（例：aria-label="サービスAの詳細"）。',
    wcag: '2.4.4',
  },
  'sr-lang-mixed': {
    severity: 'decide',
    title: '日本語ページ内の英文に lang="en" がない',
    why: '英文が日本語の発音で読み上げられる場合がある。',
    fix: '英文を囲む要素に lang="en" を付ける。',
    wcag: '3.1.2',
  },
  'sr-aria-hidden-focusable': {
    severity: 'fix',
    title: 'aria-hidden="true" の中に、フォーカスできるリンクやボタンがある',
    why: 'キーボードでは移動できるのに、読み上げでは何も読まれない「空のフォーカス」になる。',
    fix: 'aria-hidden を外すか、中のリンク・ボタンに tabindex="-1" を付ける（隠すメニューなら inert 属性を使う）。',
    wcag: '4.1.2',
  },
  'sr-visual-order': {
    severity: 'review',
    title: '見た目の順番と、読み上げ・Tabキーの順番が違う可能性がある',
    why: 'CSSの order や row-reverse で並びを入れ替えると、読み上げとTabキーはHTMLの順番で進む。',
    fix: '意味のある順番ならHTMLの順番を入れ替える。デザイン上の入れ替えだけなら問題ない場合もある。',
    wcag: '1.3.2',
  },
  'tabindex-positive': {
    severity: 'decide',
    title: '正の tabindex（1以上）が使われている',
    why: 'Tabキーの順番がHTMLの順番と変わり、操作の流れが分かりにくくなる。',
    fix: 'tabindex は 0 か -1 だけを使い、順番はHTMLの並びで決める。',
    wcag: '2.4.3',
  },
  'focus-outline-removed': {
    severity: 'fix',
    title: 'フォーカスの枠（outline）を消すCSSがある',
    why: ':focus の outline を消していて、:focus-visible での代わりの表示もない。キーボードで操作する人が、今どこにいるか分からない。',
    fix: 'その指定を削除する。クリック時だけ枠を消したいなら :focus:not(:focus-visible) { outline: none } にし、:focus-visible に枠を指定する。',
    wcag: '2.4.7',
  },
  'aria-snapshot': {
    severity: 'review',
    title: 'スクリーンリーダーに伝わる内容（アクセシビリティツリー）',
    why: '読み上げの順番と、各要素の名前・役割が自然かは、人が読んで判断する必要がある。',
    fix: 'ファイルを開き、見出し・リンク・ボタンの名前と順番が、画面の見た目と合っているか確認する。',
  },
});

interface A11yRes {
  symbols: string[];
  emoji: string[];
  sameText: string[];
  langMixed: string[];
  ariaHiddenFocusable: string[];
  visualOrder: string[];
  tabindex: string[];
}

export async function runA11yExtra(ctx: DeepCtx): Promise<void> {
  const { opts } = ctx;
  const bc = await newSafeContext(ctx.browser);
  const pw = await bc.newPage();
  try {
    for (const page of ctx.pages) {
      await gotoPage(pw, opts, page);
      const r = await probe<A11yRes>(pw, 'a11yExtra');
      check('sr-symbols', page, r.symbols);
      check('sr-emoji', page, r.emoji);
      check('sr-same-link-text', page, r.sameText);
      check('sr-lang-mixed', page, r.langMixed);
      check('sr-aria-hidden-focusable', page, r.ariaHiddenFocusable);
      check('sr-visual-order', page, r.visualOrder);
      check('tabindex-positive', page, r.tabindex);
      check('focus-outline-removed', page, await probe<string[]>(pw, 'focusOutlineRules'));
      const pi = await probe<{ printRules: boolean }>(pw, 'printInfo');
      pushFact('printCss', { page, hasPrintRules: pi.printRules });

      try {
        const snap = await pw.locator('body').ariaSnapshot({ timeout: 15000 });
        const rel = path.join('aria', `${slug(page)}.yml`);
        await mkdir(path.join(opts.out, 'aria'), { recursive: true });
        await writeFile(path.join(opts.out, rel), snap);
        add('aria-snapshot', page, `${snap.split('\n').length}行`, undefined, rel);
      } catch {
        bumpPass(0);
      }
    }
  } finally {
    await bc.close();
  }
}
