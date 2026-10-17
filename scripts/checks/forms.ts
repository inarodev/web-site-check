/**
 * 標準：フォーム
 * 空のまま送信、連打、長い入力、送信失敗時の表示を確認する。
 * 送信リクエスト（GET以外）はすべてブラウザ内でモックし、サーバーには届けない。
 */
import type { Locator, Page } from 'playwright';
import { add, bumpPass, check, registerDefs, snippet } from '../lib/core.js';
import { gotoPage, newSafeContext, probe, saveShot } from '../lib/browser.js';
import type { DeepCtx } from '../lib/browser.js';

registerDefs({
  'form-double-submit': {
    severity: 'fix',
    title: '送信ボタンを連打すると、送信が複数回行われる',
    why: '同じ問い合わせが重複して届いたり、注文が二重になったりする。',
    fix: '送信を始めたらボタンを disabled にする、送信中フラグで2回目を止めるなど。',
  },
  'form-empty-sent': {
    severity: 'review',
    title: '必須項目が空のまま送信リクエストが出る',
    why: 'ブラウザ側で必須チェックをしていない。サーバー側で検証してエラーを返すなら問題ないが、空の問い合わせが届く作りなら直す必要がある。',
    fix: '入力欄に required を付ける、送信前にJSで検証するなど。サーバー側の検証も確認する。',
    wcag: '3.3.1',
  },
  'form-no-required': {
    severity: 'decide',
    title: 'フォームに必須項目の指定がない',
    why: '必須の入力欄が分からず、空のまま送信できる。意図的に任意項目だけのフォームなら対応不要。',
    fix: '必須の項目に required と「必須」の表示を付ける。',
    wcag: '3.3.2',
  },
  'form-long-input': {
    severity: 'review',
    title: '長い文字を入力するとレイアウトが崩れる',
    why: '想定外に長い入力（URLや英単語の連続）で、横スクロールが出たり、入力欄がはみ出したりする。',
    fix: '入力欄に max-width: 100%、確認画面のテキストに overflow-wrap: anywhere を付ける。必要なら maxlength を設定する。',
  },
  'form-network-error': {
    severity: 'review',
    title: '送信に失敗したとき、利用者に伝わる表示が見つからない',
    why: '通信エラーで送れなかったのに、利用者は送れたと思ってしまう可能性がある。',
    fix: '送信失敗時に「送信できませんでした」などのメッセージを表示する。',
    wcag: '3.3.1',
  },
  'form-captcha': {
    severity: 'manual',
    title: 'CAPTCHAがあるため、フォームの自動テストは一部しか確認できていない',
    why: 'reCAPTCHA などは自動操作では通過できない。',
    fix: 'ブラウザで実際に送信テストを行い、完了画面・自動返信メール・管理者宛メールを確認する。',
  },
});

interface FormInfo {
  i: number;
  search: boolean;
  method: string;
  action: string;
  fields: number;
  required: number;
  novalidate: boolean;
  hasSubmit: boolean;
  captcha: boolean;
  desc: string;
}

const SUBMIT = 'button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]';

function valueFor(type: string, name: string): string {
  const n = name.toLowerCase();
  if (type === 'email' || /mail/.test(n)) return 'test@example.com';
  if (type === 'tel' || /tel|phone/.test(n)) return '0312345678';
  if (type === 'url' || /url|website/.test(n)) return 'https://example.com';
  if (type === 'number') return '1';
  if (type === 'date') return '2030-01-01';
  if (/zip|postal|yubin/.test(n)) return '1000001';
  if (/kana|furigana/.test(n)) return 'テスト';
  return 'テスト（web-site-check）';
}

async function fillValid(form: Locator, long = false): Promise<void> {
  const fields = form.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="file"]), select, textarea');
  const n = await fields.count();
  const radios = new Set<string>();
  for (let k = 0; k < n; k++) {
    const f = fields.nth(k);
    if (!(await f.isVisible().catch(() => false))) continue;
    const tag = await f.evaluate((e) => e.tagName.toLowerCase());
    const type = ((await f.getAttribute('type')) ?? 'text').toLowerCase();
    const name = (await f.getAttribute('name')) ?? '';
    try {
      if (tag === 'select') {
        const opts = await f.locator('option').count();
        if (opts > 1) await f.selectOption({ index: 1 });
      } else if (type === 'checkbox') {
        await f.check({ timeout: 2000 });
      } else if (type === 'radio') {
        if (!radios.has(name)) {
          radios.add(name);
          await f.check({ timeout: 2000 });
        }
      } else if (long && (tag === 'textarea' || type === 'text' || type === '')) {
        await f.fill('長い入力のテスト' + 'あいうえお'.repeat(40) + 'https://example.com/' + 'a'.repeat(300) + '😀😀😀', { timeout: 3000 });
      } else {
        await f.fill(valueFor(type, name), { timeout: 3000 });
      }
    } catch {
      /* 入力できない欄は飛ばす */
    }
  }
}

async function reload(pw: Page, ctx: DeepCtx, page: string): Promise<void> {
  await gotoPage(pw, ctx.opts, page);
  await pw.waitForTimeout(300);
}

export async function runForms(ctx: DeepCtx): Promise<void> {
  const { opts } = ctx;
  const bc = await newSafeContext(ctx.browser);
  const pw = await bc.newPage();
  let tested = 0;
  try {
    for (const page of ctx.allPages.slice(0, 15)) {
      if (tested >= 6) break;
      await reload(pw, ctx, page);
      const forms = (await probe<FormInfo[]>(pw, 'forms')).filter((f) => !f.search && f.hasSubmit && f.fields > 0);
      for (const info of forms.slice(0, 3)) {
        tested++;
        const label = `${info.desc}（${info.method ? `method=${info.method}` : 'method指定なし'}${info.action ? `, action=${snippet(info.action, 30)}` : ''}）`;
        const form = (): Locator => pw.locator('form').nth(info.i);
        if (info.captcha) add('form-captcha', page, label);

        // 1) 必須項目
        if (info.required === 0) add('form-no-required', page, label);
        else bumpPass();

        // 2) 空のまま送信
        if (info.required > 0) {
          await reload(pw, ctx, page);
          const before = bc.mutatingRequests.length;
          const navBefore = pw.url();
          await form().locator(SUBMIT).first().click({ timeout: 3000, noWaitAfter: true }).catch(() => undefined);
          await pw.waitForTimeout(1500);
          const sent = bc.mutatingRequests.length - before > 0 || (info.method !== 'post' && pw.url() !== navBefore);
          check('form-empty-sent', page, sent ? [label] : []);
        }

        // 3) 連打
        await reload(pw, ctx, page);
        await fillValid(form());
        const before = bc.mutatingRequests.length;
        const btn = form().locator(SUBMIT).first();
        for (let k = 0; k < 5; k++) {
          await btn.click({ timeout: 1500, noWaitAfter: true, force: true }).catch(() => undefined);
          await pw.waitForTimeout(60);
        }
        await pw.waitForTimeout(2000);
        const count = bc.mutatingRequests.length - before;
        check('form-double-submit', page, count > 1 ? [`5回クリックで送信リクエストが${count}回：${label}`] : []);

        // 4) 長い入力
        await reload(pw, ctx, page);
        await fillValid(form(), true);
        await pw.waitForTimeout(300);
        const o = await probe<{ overflow: boolean; sw: number; offenders: string[] }>(pw, 'overflow');
        if (o.overflow) add('form-long-input', page, `${label}：ページ幅${o.sw}px`, undefined, await saveShot(pw, opts, page, `form-long-${info.i}`, false));
        else bumpPass();

        // 5) 送信失敗時の表示（GET以外の送信を、この検査中だけ失敗させる）
        {
          await reload(pw, ctx, page);
          await fillValid(form());
          const textBefore = await probe<string>(pw, 'pageText');
          await pw.route('**/*', (route) => (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.fallback() : route.abort('failed')));
          await form().locator(SUBMIT).first().click({ timeout: 3000, noWaitAfter: true }).catch(() => undefined);
          await pw.waitForTimeout(2500);
          let textAfter = '';
          try {
            textAfter = await probe<string>(pw, 'pageText');
          } catch {
            textAfter = '';
          }
          const browserErrorPage = pw.url().startsWith('chrome-error:');
          await pw.unroute('**/*');
          const added = textAfter.replace(textBefore, '');
          const hasError = /エラー|失敗|できませんでした|送信できません|もう一度|error|failed|try again/i.test(added) || /エラー|失敗|できませんでした/.test(textAfter.slice(0, 2000)) && textAfter !== textBefore;
          // ページ遷移で送るフォームは、ブラウザ自身がエラー画面を出すので対象外
          check('form-network-error', page, hasError || browserErrorPage ? [] : [label]);
        }
      }
    }
  } finally {
    console.log(`    モックした送信リクエスト: ${bc.mutatingRequests.length}件（サーバーには送信していません）`);
    await bc.close();
  }
}
