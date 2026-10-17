import type { CheckDef, Finding, Options, Severity } from './types.js';
import { QUICK_DEFS } from './defs-quick.js';

// ---------- 定義の登録 ----------
const defs: Record<string, CheckDef> = { ...QUICK_DEFS };

export function registerDefs(extra: Record<string, CheckDef>): void {
  for (const [id, d] of Object.entries(extra)) {
    if (defs[id]) throw new Error(`チェックIDが重複しています: ${id}`);
    defs[id] = d;
  }
}

/** 実行時に定義を追加する（Lighthouseの監査など、IDが事前に決まらないもの）。既にあれば何もしない */
export function ensureDef(id: string, d: CheckDef): void {
  if (!defs[id]) defs[id] = d;
}

// ---------- 集計 ----------
const findings = new Map<string, Finding>();
let passCount = 0;

export function add(id: string, page: string, excerpt?: string, severity?: Severity, file?: string): void {
  const def = defs[id];
  if (!def) throw new Error(`未定義のチェックID: ${id}`);
  const sev = severity ?? def.severity;
  const key = `${def.group ?? id}:${sev}`;
  let f = findings.get(key);
  if (!f) {
    f = { id, severity: sev, title: def.title, why: def.why, fix: def.fix, wcag: def.wcag, occurrences: [] };
    findings.set(key, f);
  }
  f.occurrences.push({ page, excerpt, file });
}

/** 検査を1件実行する。問題が0なら合格として数える。 */
export function check(id: string, page: string, problems: Array<string | undefined>, severity?: Severity): void {
  if (problems.length === 0) {
    passCount += 1;
    return;
  }
  for (const p of problems) add(id, page, p, severity);
}

// ---------- 判断材料（findings.json の facts に出す。要判断の質問を作るのに使う） ----------
const facts: Record<string, unknown> = {};
export function setFact(key: string, value: unknown): void {
  facts[key] = value;
}
export function pushFact(key: string, value: unknown): void {
  const cur = (facts[key] as unknown[] | undefined) ?? [];
  if (!cur.some((v) => JSON.stringify(v) === JSON.stringify(value))) cur.push(value);
  facts[key] = cur;
}
export function getFacts(): Record<string, unknown> {
  return facts;
}

export function bumpPass(n = 1): void {
  passCount += n;
}
export function getPass(): number {
  return passCount;
}
export function getFindings(): Finding[] {
  return [...findings.values()];
}

/** 1つの検査モジュールを実行する。失敗しても全体は止めず、手動確認として記録する */
export async function runModule(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  console.log(`  - ${name} ...`);
  try {
    await fn();
    console.log(`    完了（${Math.round((Date.now() - t0) / 1000)}秒）`);
  } catch (e) {
    const msg = (e as Error).message?.split('\n')[0] ?? String(e);
    console.log(`    失敗: ${msg}`);
    add('module-failed', '-', `${name}: ${msg}`);
  }
}

// ---------- 文字列 ----------
export function snippet(s: string, n = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** ページのパスを、ファイル名に使える文字列にする */
export function slug(page: string): string {
  const s = page.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return s || 'top';
}

// ---------- 取得系 ----------
export const UA = 'web-site-check/0.2 (+local audit)';

export async function fetchText(url: string): Promise<{ status: number; headers: Headers; body: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    const ct = res.headers.get('content-type') ?? '';
    const body = ct.includes('text') || ct.includes('xml') || ct.includes('json') || ct.includes('javascript') ? await res.text() : '';
    return { status: res.status, headers: res.headers, body, finalUrl: res.url };
  } catch {
    return null;
  }
}

export async function headStatus(url: string): Promise<number | null> {
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    }
    return res.status;
  } catch {
    return null;
  }
}

export function toPagePath(u: URL): string {
  return u.pathname + u.search;
}

// ---------- レポート ----------
export const SECTION: Record<Severity, { label: string; order: number }> = {
  fix: { label: '🔴 要修正', order: 0 },
  decide: { label: '🟠 要判断', order: 1 },
  review: { label: '🟡 目視確認', order: 2 },
  manual: { label: '⚪ 手動確認', order: 3 },
};

const PROFILE_LABEL = { quick: 'クイック', standard: '標準', full: 'フル' } as const;

export function sortedFindings(): Finding[] {
  return getFindings().sort((a, b) => SECTION[a.severity].order - SECTION[b.severity].order);
}

export function summarize(list: Finding[]): Record<Severity, { items: number; spots: number }> & { pass: number } {
  const sum = (s: Severity): { items: number; spots: number } => ({
    items: list.filter((f) => f.severity === s).length,
    spots: list.filter((f) => f.severity === s).reduce((n, f) => n + f.occurrences.length, 0),
  });
  return { fix: sum('fix'), decide: sum('decide'), review: sum('review'), manual: sum('manual'), pass: passCount };
}

export function renderReport(opts: Options, pages: string[], list: Finding[], elapsedSec: number): string {
  const sm = summarize(list);
  const label = (s: Severity): string => `${SECTION[s].label} ${sm[s].items}項目（${sm[s].spots}箇所）`;
  // 優先して見る項目は、公開事故につながるものから並べる
  const PRIORITY = ['exposed-file', 'noindex-found', 'robots-disallow-all', 'nojs-overlay', 'jsfail-overlay', 'thirdparty-fail', 'nojs-hidden-content', 'jsfail-hidden-content', 'form-double-submit', 'dark-contrast', 'color-pair', 'layout-overflow', 'header-covers-content', 'mixed-content', 'canonical-local', 'sitemap-placeholder', 'dev-url-leak', 'dummy-text', 'html-validate', 'link-broken', 'keyboard-trap', 'focus-invisible', 'focus-outline-removed'];
  const rank = (id: string): number => (PRIORITY.includes(id) ? PRIORITY.indexOf(id) : PRIORITY.length);
  const top = list.filter((f) => f.severity === 'fix').sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 3);
  const out: string[] = [];
  out.push(`# Webサイトチェック レポート（${PROFILE_LABEL[opts.profile]}・下書き）`);
  out.push('');
  out.push(`- 対象：${opts.base.origin}（${pages.length}ページ）`);
  out.push(`- 所要時間：約${Math.max(1, Math.round(elapsedSec / 60))}分`);
  out.push(`- 件数：${label('fix')} / ${label('decide')} / ${label('review')} / ${label('manual')} / 🟢 合格 ${passCount}件`);
  const lh = facts['lighthouse'] as Array<{ page: string; formFactor: string; scores: string }> | undefined;
  if (lh && lh.length > 0) {
    out.push('- Lighthouse（参考値）：');
    for (const l of lh) out.push(`  - ${l.page}（${l.formFactor === 'mobile' ? 'モバイル' : 'PC'}）：${l.scores}`);
  }
  if (top.length > 0) {
    out.push('- 優先して見る項目：');
    for (const f of top) out.push(`  - ${f.title}（${f.occurrences.length}箇所）`);
  }
  out.push('');
  for (const sev of ['fix', 'decide', 'review', 'manual'] as Severity[]) {
    const items = list.filter((f) => f.severity === sev);
    out.push(`## ${SECTION[sev].label}`);
    out.push('');
    if (items.length === 0) {
      out.push('該当なし');
      out.push('');
      continue;
    }
    for (const f of items) {
      const pageSet = [...new Set(f.occurrences.map((o) => o.page))];
      out.push(`- [ ] **${f.title}**（${f.occurrences.length}箇所 / ${pageSet.slice(0, 3).join(', ')}${pageSet.length > 3 ? ` ほか${pageSet.length - 3}ページ` : ''}）`);
      for (const o of f.occurrences.slice(0, 3)) {
        out.push(`  - 箇所：${o.page}${o.excerpt ? ` ／ \`${o.excerpt.replace(/`/g, "'")}\`` : ''}${o.file ? ` ／ 証跡：${o.file}` : ''}`);
      }
      if (f.occurrences.length > 3) {
        const files = f.occurrences.slice(3).map((o) => o.file).filter(Boolean);
        out.push(`  - ほか${f.occurrences.length - 3}箇所${files.length > 0 ? `（証跡：${files.slice(0, 6).join(', ')}${files.length > 6 ? ' ほか' : ''}）` : ''}`);
      }
      out.push(`  - 理由：${f.why}${f.wcag ? `（WCAG ${f.wcag}）` : ''}`);
      out.push(`  - 修正案：${f.fix}`);
    }
    out.push('');
  }
  return out.join('\n');
}
