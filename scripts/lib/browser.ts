import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import type { Options } from './types.js';
import { slug } from './core.js';

export interface DeepCtx {
  opts: Options;
  browser: Browser;
  /** 重い検査を行う代表ページ */
  pages: string[];
  /** 検査対象の全ページ */
  allPages: string[];
}

const PROBE_SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser', 'probe.js'), 'utf8');

/**
 * ブラウザ内の判定処理（browser/probe.js）を呼ぶ。
 * 文字列で渡すので、TypeScriptの変換の影響を受けず、CSPのあるページでも動く。
 */
export async function probe<T>(pw: Page, fn: string, ...args: unknown[]): Promise<T> {
  await pw.evaluate(PROBE_SRC);
  return (await pw.evaluate(`window.__wsc.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`)) as T;
}

/** ブラウザを起動する。失敗したら null */
export async function launchChromium(args: string[] = []): Promise<Browser | null> {
  try {
    const { chromium } = await import('playwright');
    return await chromium.launch({ args });
  } catch {
    return null;
  }
}

/**
 * 安全なコンテキストを作る。
 * GET/HEAD/OPTIONS 以外のリクエスト（フォーム送信・計測のPOSTなど）は外へ出さず、ここで200を返す。
 * 検査中に本番の問い合わせやデータ更新が起きないようにするため。
 */
export async function newSafeContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext & { mutatingRequests: string[] }> {
  const ctx = (await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options })) as BrowserContext & { mutatingRequests: string[] };
  ctx.mutatingRequests = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const m = req.method().toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return route.continue();
    ctx.mutatingRequests.push(`${m} ${req.url()}`);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"web-site-check":"mocked"}' });
  });
  return ctx;
}

export async function gotoPage(pw: Page, opts: Options, page: string, timeout = 30000): Promise<void> {
  await pw.goto(new URL(page, opts.base).href, { waitUntil: 'load', timeout });
  await pw.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
}

/** 遅延読み込みやスクロール連動の表示を発火させる */
export async function scrollThrough(pw: Page): Promise<void> {
  await pw.evaluate(async () => {
    const step = Math.max(300, window.innerHeight * 0.8);
    const max = Math.min(document.documentElement.scrollHeight, 30000);
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 100));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 200));
  });
}

/** スクリーンショットを保存し、出力ディレクトリからの相対パスを返す */
export async function saveShot(pw: Page, opts: Options, page: string, label: string, fullPage = true): Promise<string | undefined> {
  const rel = path.join('screenshots', `${slug(page)}__${label}.png`);
  try {
    await mkdir(path.join(opts.out, 'screenshots'), { recursive: true });
    await pw.screenshot({ path: path.join(opts.out, rel), fullPage, timeout: 20000 });
    return rel;
  } catch {
    return undefined;
  }
}

/**
 * 代表ページを選ぶ。トップを先頭に、URLの1階層目が異なるページ（テンプレートが違う可能性が高い）を優先する。
 */
export function pickRepresentative(pages: string[], n: number): string[] {
  const out: string[] = [];
  const seenGroup = new Set<string>();
  const group = (p: string): string => p.split('?')[0]!.split('/').filter(Boolean)[0] ?? '';
  for (const p of pages) {
    if (out.length >= n) break;
    const g = group(p);
    if (!seenGroup.has(g)) {
      seenGroup.add(g);
      out.push(p);
    }
  }
  for (const p of pages) {
    if (out.length >= n) break;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
