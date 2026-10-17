/**
 * 標準：Lighthouse（アクセシビリティ・ベストプラクティス・SEO）
 * フル：パフォーマンスとPC表示（desktop）も追加
 *
 * スコアの合格ラインは設けず、個別の監査（audit）ごとに4区分へ振り分ける。
 * ほかの検査で既に見ている項目は、二重に報告しないよう除外する。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { add, ensureDef, pushFact, registerDefs, slug, snippet } from '../lib/core.js';
import type { Options, Severity } from '../lib/types.js';

registerDefs({
  'lh-manual': {
    severity: 'manual',
    title: 'Lighthouseが「手動で確認」としている項目',
    why: '自動では判定できないアクセシビリティの項目。',
    fix: '各項目を、キーボード操作やスクリーンリーダーで確認する。',
  },
  'lh-unavailable': {
    severity: 'manual',
    title: 'Lighthouseを実行できなかった',
    why: 'Lighthouseが導入されていない、またはブラウザを起動できなかった。',
    fix: 'node setup.mjs --install を実行してから再実行する。',
  },
});

/** ほかの検査で見ている監査（二重に報告しない）と、ローカル環境では意味がない監査 */
const SKIP = new Set([
  'html-has-lang', 'document-title', 'meta-description', 'viewport', 'meta-viewport', 'image-alt', 'is-crawlable', 'robots-txt',
  'hreflang', 'canonical', 'label', 'link-name', 'button-name', 'heading-order', 'link-text', 'errors-in-console', 'unsized-images',
  'modern-image-formats', 'uses-responsive-images', 'font-size', 'frame-title', 'video-caption', 'tabindex', 'target-size', 'tap-targets',
  'is-on-https', 'redirects-http', 'uses-http2', 'image-size-responsive', 'landmark-one-main', 'input-image-alt', 'crawlable-anchors',
  // パフォーマンス：独自の検査（キャッシュ・圧縮・font-display・画像）と重複するもの
  'uses-long-cache-ttl', 'uses-text-compression', 'font-display', 'uses-optimized-images',
]);

const WCAG: Record<string, string> = {
  'color-contrast': '1.4.3', 'aria-allowed-attr': '4.1.2', 'aria-hidden-body': '4.1.2', 'aria-hidden-focus': '4.1.2', 'aria-required-attr': '4.1.2',
  'aria-roles': '4.1.2', 'aria-valid-attr': '4.1.2', 'aria-valid-attr-value': '4.1.2', 'aria-command-name': '4.1.2', 'aria-input-field-name': '4.1.2',
  'aria-toggle-field-name': '4.1.2', 'select-name': '4.1.2', 'duplicate-id-aria': '4.1.1', 'list': '1.3.1', 'listitem': '1.3.1', 'definition-list': '1.3.1',
  'dlitem': '1.3.1', 'td-headers-attr': '1.3.1', 'th-has-data-cells': '1.3.1', 'valid-lang': '3.1.2', 'bypass': '2.4.1', 'skip-link': '2.4.1',
  'link-in-text-block': '1.4.1', 'object-alt': '1.1.1', 'image-redundant-alt': '1.1.1', 'form-field-multiple-labels': '3.3.2', 'meta-refresh': '2.2.1',
};

const CATS_STANDARD = ['accessibility', 'best-practices', 'seo'];
const CAT_LABEL: Record<string, string> = { accessibility: 'アクセシビリティ', 'best-practices': 'ベストプラクティス', seo: 'SEO', performance: 'パフォーマンス' };

interface LhAudit {
  id: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string;
  displayValue?: string;
  details?: { type?: string; items?: Array<Record<string, unknown>> };
}
interface LhResult {
  categories: Record<string, { score: number | null; auditRefs: Array<{ id: string; group?: string }> }>;
  audits: Record<string, LhAudit>;
  runWarnings?: string[];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('port'))));
    });
  });
}

function itemLabel(it: Record<string, unknown>): string {
  const node = it['node'] as { nodeLabel?: string; snippet?: string; selector?: string } | undefined;
  if (node) return snippet(node.nodeLabel || node.snippet || node.selector || '', 50);
  const src = it['source'] as { url?: string } | undefined;
  const url = (it['url'] as string | undefined) ?? src?.url;
  if (url) return snippet(url, 60);
  return '';
}

function cleanDescription(d: string): { text: string; url?: string } {
  const m = d.match(/\[[^\]]+\]\((https?:[^)]+)\)/);
  const text = d.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
  return { text: snippet(text, 160), url: m?.[1] };
}

export async function runLighthouse(opts: Options, pages: string[]): Promise<void> {
  let lighthouse: (url: string, flags: Record<string, unknown>, config?: unknown) => Promise<{ lhr: LhResult } | undefined>;
  let desktopConfig: unknown;
  let chromium: typeof import('playwright').chromium;
  try {
    lighthouse = (await import('lighthouse')).default as unknown as typeof lighthouse;
    desktopConfig = (await import('lighthouse/core/config/desktop-config.js')).default;
    ({ chromium } = await import('playwright'));
  } catch (e) {
    add('lh-unavailable', '-', `読み込めません: ${(e as Error).message.split('\n')[0]}`);
    return;
  }
  const full = opts.profile === 'full';
  const cats = full ? [...CATS_STANDARD, 'performance'] : CATS_STANDARD;
  const formFactors: Array<'mobile' | 'desktop'> = full ? ['mobile', 'desktop'] : ['mobile'];
  const port = await freePort();
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const manualSeen = new Set<string>();
  await mkdir(path.join(opts.out, 'lighthouse'), { recursive: true });
  try {
    for (const page of pages) {
      for (const ff of formFactors) {
        const url = new URL(page, opts.base).href;
        const flags = { port, output: 'json', logLevel: 'error', onlyCategories: cats, locale: 'ja' };
        const res = await lighthouse(url, flags, ff === 'desktop' ? desktopConfig : undefined);
        if (!res) continue;
        const lhr = res.lhr;
        const rel = path.join('lighthouse', `${slug(page)}-${ff}.json`);
        await writeFile(path.join(opts.out, rel), JSON.stringify(lhr));
        const scoreLine = cats.map((c) => `${CAT_LABEL[c]} ${lhr.categories[c]?.score === null || lhr.categories[c] === undefined ? '-' : Math.round((lhr.categories[c]!.score ?? 0) * 100)}`).join(' / ');
        // スコアは指摘ではなく参考値として、レポートの冒頭に出す
        pushFact('lighthouse', { page, formFactor: ff, scores: scoreLine, file: rel });

        for (const cat of cats) {
          const c = lhr.categories[cat];
          if (!c) continue;
          for (const ref of c.auditRefs) {
            const a = lhr.audits[ref.id];
            // group が hidden の監査は、Lighthouse自身が画面に出していない重複（新しい insight 版など）なので除外する
            if (!a || SKIP.has(a.id) || ref.group === 'hidden') continue;
            if (a.scoreDisplayMode === 'manual') {
              if (!manualSeen.has(a.id)) {
                manualSeen.add(a.id);
                add('lh-manual', '-', a.title);
              }
              continue;
            }
            if (a.score === null || ['notApplicable', 'informative', 'error'].includes(a.scoreDisplayMode)) continue;
            let sev: Severity | null = null;
            if (cat === 'performance') {
              if (a.score >= 0.9) continue;
              sev = ref.group === 'metrics' ? 'review' : 'decide';
            } else {
              if (a.score >= 1) continue;
              sev = a.score === 0 ? 'fix' : 'decide';
            }
            const id = `lh:${a.id}`;
            const d = cleanDescription(a.description);
            ensureDef(id, {
              severity: sev,
              title: `Lighthouse（${CAT_LABEL[cat]}）：${a.title}`,
              why: d.text || a.title,
              fix: `Lighthouseの説明に沿って修正する${d.url ? `（詳細：${d.url}）` : ''}。${cat === 'performance' ? 'ローカル環境の値は本番と異なるため、本番URLでも確認する。' : ''}`,
              wcag: WCAG[a.id],
            });
            const rawItems = a.details?.items;
            const items = (Array.isArray(rawItems) ? rawItems : []).map(itemLabel).filter(Boolean).slice(0, 3);
            const ffLabel = ff === 'mobile' ? 'モバイル' : 'PC';
            add(id, page, `${ffLabel}${a.displayValue ? `：${a.displayValue}` : ''}${items.length ? ` ／ ${items.join(' / ')}` : ''}`, sev);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
}
