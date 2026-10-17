/**
 * フル：操作
 * ホバー表現の有無、Tabキーでの到達・フォーカス表示・キーボードトラップ、スキップリンク、マウスでしか操作できない要素
 */
import { add, bumpPass, check, registerDefs } from '../lib/core.js';
import { gotoPage, newSafeContext, probe, saveShot } from '../lib/browser.js';
import type { DeepCtx } from '../lib/browser.js';

registerDefs({
  'hover-missing': {
    severity: 'review',
    title: 'マウスを乗せても見た目が変わらないリンク・ボタン',
    why: 'ホバー表現の付け忘れの可能性がある。ロゴや、意図してホバーを付けない要素なら対応不要。',
    fix: ':hover で色・下線・透明度などを変える。スクリーンショットの赤い点線が対象。',
  },
  'focus-invisible': {
    severity: 'fix',
    title: 'Tabキーで移動したとき、フォーカスの位置が見えない',
    why: 'outline: none などでフォーカスの枠を消していて、代わりの表示もない。キーボードで操作する人が、今どこにいるか分からない。',
    fix: ':focus-visible に outline か box-shadow を指定する（例：a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }）。',
    wcag: '2.4.7',
  },
  'keyboard-unreachable': {
    severity: 'review',
    title: 'Tabキーで到達しなかったリンク・ボタン',
    why: '画面に見えているのに、Tabキーで移動できない可能性がある。閉じたメニューの中など、意図的に除外しているなら問題ない。',
    fix: 'Tabキーで実際に移動して確認する。到達できないなら、tabindex="-1" の削除や、要素を a・button に変えるなどで直す。',
    wcag: '2.1.1',
  },
  'keyboard-trap': {
    severity: 'fix',
    title: 'Tabキーを押してもフォーカスが先へ進まない箇所がある（キーボードトラップ）',
    why: 'キーボードだけで操作している人が、そこから抜け出せなくなる。',
    fix: '埋め込み（地図・動画・独自のウィジェット）のフォーカス制御を見直す。',
    wcag: '2.1.2',
  },
  'skip-link-missing': {
    severity: 'decide',
    title: '本文へ移動するスキップリンクがない',
    why: 'ナビゲーションのリンクが多いと、キーボードで本文にたどり着くまでに何度もTabキーを押す必要がある。',
    fix: 'ページ先頭に「本文へスキップ」のリンク（<a href="#main">）を置き、フォーカス時だけ表示する。',
    wcag: '2.4.1',
  },
  'mouse-only': {
    severity: 'fix',
    title: 'マウスでしか操作できない要素がある可能性',
    why: 'カーソルが指の形になる（クリックできる）のに、Tabキーでフォーカスできない。div や span にクリック処理だけを付けている可能性がある。',
    fix: 'button か a に変える。どうしても div を使うなら role="button" と tabindex="0" を付け、Enter・Spaceキーにも反応させる。',
    wcag: '2.1.1',
  },
});

interface HoverTarget {
  i: number;
  key: string;
  desc: string;
}
interface Focusable {
  i: number;
  desc: string;
  snap: string;
}
interface Active {
  f: string | null;
  desc: string;
  snap: string;
  outline: boolean;
  href: string;
}

export async function runInteraction(ctx: DeepCtx): Promise<void> {
  const { opts } = ctx;
  const bc = await newSafeContext(ctx.browser, { viewport: { width: 1440, height: 900 } });
  const pw = await bc.newPage();
  const testedKeys = new Set<string>();
  try {
    for (const page of ctx.pages) {
      // ---------- ホバー ----------
      await gotoPage(pw, opts, page);
      const targets = (await probe<HoverTarget[]>(pw, 'markHoverTargets', 60)).filter((t) => !testedKeys.has(t.key));
      const noHover: string[] = [];
      for (const t of targets.slice(0, 40)) {
        testedKeys.add(t.key);
        const loc = pw.locator(`[data-wsc-h="${t.i}"]`);
        try {
          await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
          await pw.mouse.move(1, 1);
          await pw.waitForTimeout(120);
          const before = await probe<string | null>(pw, 'hoverSnap', t.i);
          await loc.hover({ timeout: 2000 });
          await pw.waitForTimeout(450); // transition の完了を待つ
          const after = await probe<string | null>(pw, 'hoverSnap', t.i);
          if (before !== null && before === after) {
            noHover.push(t.desc);
            await loc.evaluate((el) => el.setAttribute('data-wsc-nohover', '1')).catch(() => undefined);
          }
        } catch {
          /* 隠れている要素などは飛ばす */
        }
      }
      await pw.mouse.move(1, 1);
      if (noHover.length > 0) {
        await pw.addStyleTag({ content: '[data-wsc-nohover]{outline:3px dashed #e00 !important;outline-offset:2px !important}' }).catch(() => undefined);
        const shot = await saveShot(pw, opts, page, 'no-hover');
        for (const d of noHover.slice(0, 8)) add('hover-missing', page, d, undefined, shot);
        if (noHover.length > 8) add('hover-missing', page, `ほか${noHover.length - 8}件（スクリーンショットの赤い点線）`, undefined, shot);
      } else bumpPass();

      // ---------- キーボード ----------
      await gotoPage(pw, opts, page);
      const list = await probe<Focusable[]>(pw, 'markFocusables');
      const byIndex = new Map(list.map((f) => [String(f.i), f]));
      const visited = new Set<string>();
      const invisible: string[] = [];
      let first: Active | null = null;
      let same = 0;
      let last: string | null = null;
      let trap: string | null = null;
      const max = Math.min(list.length + 25, 200);
      for (let k = 0; k < max; k++) {
        await pw.keyboard.press('Tab');
        await pw.waitForTimeout(60);
        const a = await probe<Active | null>(pw, 'active').catch(() => null);
        if (!a) {
          if (visited.size > 0) break; // 最後まで進んでブラウザのUIへ抜けた
          continue;
        }
        if (!first) first = a;
        const id = a.f ?? a.desc;
        if (id === last) {
          same++;
          if (same >= 3) {
            trap = a.desc;
            break;
          }
        } else same = 0;
        last = id;
        if (a.f !== null && visited.has(a.f) && visited.size > 3) break; // 1周した
        if (a.f !== null) {
          visited.add(a.f);
          const base = byIndex.get(a.f);
          if (base && !a.outline && base.snap === a.snap && invisible.length < 8) invisible.push(a.desc);
        }
      }
      check('keyboard-trap', page, trap ? [trap] : []);
      if (invisible.length > 0) {
        const shot = await saveShot(pw, opts, page, 'focus', false);
        for (const d of invisible.slice(0, 6)) add('focus-invisible', page, d, undefined, shot);
      } else bumpPass();
      const unreached = list.filter((f) => !visited.has(String(f.i)));
      check('keyboard-unreachable', page, trap ? [] : unreached.slice(0, 6).map((f) => f.desc));
      const navLinks = await pw.locator('header a[href], nav a[href]').count().catch(() => 0);
      // 最初のTabで、ページ内リンク（#main など）に移動すればスキップリンクがあるとみなす
      const skipOk = !!first && first.href.startsWith('#') && first.href.length > 1;
      check('skip-link-missing', page, navLinks >= 6 && !skipOk ? [`ナビゲーションのリンクが${navLinks}個あり、最初のTabで本文へ移動するリンクがない`] : []);

      // ---------- マウスでしか操作できない要素 ----------
      check('mouse-only', page, await probe<string[]>(pw, 'pointerOnly'));
    }
  } finally {
    await bc.close();
  }
}
