/**
 * フル：公開前の追加検査（ブラウザ不要）
 * 公開してはいけないファイルの露出、ソースマップ、圧縮・キャッシュ、WordPressの情報露出、依存パッケージの脆弱性
 *
 * アクセスするのは、検査対象として起動したローカルのサーバーだけ。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { add, bumpPass, check, fetchText, registerDefs, snippet, UA } from '../lib/core.js';
import type { Options } from '../lib/types.js';
import type { PageData } from './quick.js';

registerDefs({
  'exposed-file': {
    severity: 'fix',
    title: '公開してはいけないファイルが見える',
    why: '.env（パスワードやAPIキー）や .git（ソースコードの履歴）が、URLを直接開くと誰でも取得できる状態になっている。',
    fix: '公開ディレクトリから削除するか、サーバーの設定でアクセスを拒否する。本番でも同じURLを確認する。漏れた可能性のあるキーは再発行する。',
  },
  'sourcemap-exposed': {
    severity: 'decide',
    title: 'ソースマップ（.map）が公開されている',
    why: '圧縮前のソースコードが誰でも読める。秘密情報がなければ問題ないことも多い。',
    fix: '公開したくなければ、本番ビルドでソースマップを出力しない設定にする（Next.js は既定で出力しない）。',
  },
  'no-compression': {
    severity: 'decide',
    title: 'HTML・CSS・JSが圧縮（gzip / brotli）されずに配信されている',
    why: '転送量が増え、表示が遅くなる。ローカルのサーバーでは圧縮しないだけで、本番のホスティングでは圧縮される場合もある。',
    fix: '本番URLでも確認し、圧縮されていなければサーバーやCDNの設定で有効にする。',
  },
  'no-cache-control': {
    severity: 'decide',
    title: 'CSS・JS・画像にキャッシュの指定（Cache-Control）がない',
    why: '再訪問のたびに同じファイルを読み込み直す。ローカルのサーバーでは設定されないだけの場合もある。',
    fix: '本番URLでも確認し、ファイル名にハッシュが付く静的ファイルには長期のキャッシュを設定する。',
  },
  'wp-user-exposed': {
    severity: 'decide',
    title: 'WordPressのユーザー名が外部から分かる',
    why: 'ログインIDの推測に使われ、総当たり攻撃の手がかりになる。',
    fix: 'REST API のユーザー一覧や ?author= のリダイレクトを、プラグインや functions.php で無効にする。',
  },
  'wp-xmlrpc': {
    severity: 'decide',
    title: 'WordPressの xmlrpc.php が有効',
    why: '使っていなければ、総当たり攻撃の入り口になる。',
    fix: 'Jetpackやアプリ投稿で使っていなければ、無効にする。',
  },
  'npm-audit': {
    severity: 'decide',
    title: '依存パッケージに脆弱性の報告がある',
    why: 'npm audit で、深刻度が高い（high・critical）脆弱性が見つかった。',
    fix: 'npm audit の結果を確認し、パッケージを更新する。破壊的な更新になる場合は影響を確認してから行う。',
  },
  'npm-audit-failed': {
    severity: 'manual',
    title: '依存パッケージの脆弱性を確認できなかった',
    why: 'npm audit を実行できなかった（ネットワーク、lockファイルなし、など）。',
    fix: 'プロジェクトのディレクトリで npm audit を実行して確認する。',
  },
});

/** パスと、本物のファイルかを見分ける判定 */
const SENSITIVE: Array<{ path: string; test: (body: string, ct: string) => boolean }> = [
  { path: '/.env', test: (b) => /^[A-Z0-9_]+\s*=/m.test(b) },
  { path: '/.env.local', test: (b) => /^[A-Z0-9_]+\s*=/m.test(b) },
  { path: '/.env.production', test: (b) => /^[A-Z0-9_]+\s*=/m.test(b) },
  { path: '/.git/HEAD', test: (b) => /^ref:\s*refs\//.test(b.trim()) },
  { path: '/.git/config', test: (b) => /\[core\]/.test(b) },
  { path: '/.DS_Store', test: (b, ct) => !/html/.test(ct) && b.length > 0 },
  { path: '/.htaccess', test: (b) => /Rewrite|Options|Deny|Require/i.test(b) },
  { path: '/wp-config.php.bak', test: (b) => /DB_PASSWORD|DB_NAME/.test(b) },
  { path: '/wp-config.php~', test: (b) => /DB_PASSWORD|DB_NAME/.test(b) },
  { path: '/package.json', test: (b) => /"dependencies"|"scripts"/.test(b) },
  { path: '/composer.json', test: (b) => /"require"/.test(b) },
  { path: '/phpinfo.php', test: (b) => /phpinfo|PHP Version/i.test(b) },
  { path: '/backup.zip', test: (_b, ct) => /zip|octet/.test(ct) },
  { path: '/readme.html', test: (b) => /WordPress/i.test(b) },
];

async function raw(url: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA, 'accept-encoding': 'gzip, br', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15000), ...init });
  } catch {
    return null;
  }
}

/** 標準以上：公開してはいけないファイルの露出 */
export async function runExposedFiles(opts: Options): Promise<void> {
  const exposed: string[] = [];
  for (const s of SENSITIVE) {
    const r = await raw(new URL(s.path, opts.base).href);
    if (!r || r.status !== 200) continue;
    const ct = r.headers.get('content-type') ?? '';
    const body = await r.text().catch(() => '');
    if (s.test(body, ct)) exposed.push(s.path);
  }
  check('exposed-file', '-', exposed);
}

/** フル：ソースマップ・圧縮・キャッシュ・WordPress・npm audit */
export async function runReleaseExtra(opts: Options, datas: PageData[]): Promise<void> {

  // ---------- ソースマップ・圧縮・キャッシュ ----------
  const assets = new Set<string>();
  for (const d of datas.slice(0, 5)) {
    const $ = cheerio.load(d.html);
    $('script[src], link[rel~="stylesheet"][href], img[src]').each((_, el) => {
      const v = $(el).attr('src') ?? $(el).attr('href');
      if (!v) return;
      try {
        const u = new URL(v, d.url);
        if (u.origin === opts.base.origin) assets.add(u.href);
      } catch {
        /* 無視 */
      }
    });
  }
  const maps: string[] = [];
  const uncompressed: string[] = [];
  const noCache: string[] = [];
  const first = datas[0] ? new URL(datas[0].page, opts.base).href : opts.base.href;
  for (const url of [first, ...[...assets].slice(0, 30)]) {
    const r = await raw(url);
    if (!r || r.status !== 200) continue;
    const ct = r.headers.get('content-type') ?? '';
    const len = Number(r.headers.get('content-length') ?? 0);
    const text = /javascript|css|html/.test(ct);
    const body = text ? await r.text().catch(() => '') : '';
    if (text && !r.headers.get('content-encoding') && (len || body.length) > 1024) uncompressed.push(snippet(url.replace(opts.base.origin, ''), 60));
    if (url !== first && !r.headers.get('cache-control')) noCache.push(snippet(url.replace(opts.base.origin, ''), 60));
    if (/javascript|css/.test(ct)) {
      const m = body.match(/[#@]\s*sourceMappingURL=([^\s*]+)/);
      const header = r.headers.get('sourcemap') ?? r.headers.get('x-sourcemap');
      const ref = m?.[1] ?? header;
      if (ref && !ref.startsWith('data:')) {
        const mapUrl = new URL(ref, url).href;
        const mr = await raw(mapUrl);
        if (mr && mr.status === 200 && /"mappings"/.test(await mr.text().catch(() => ''))) maps.push(snippet(mapUrl.replace(opts.base.origin, ''), 60));
      }
    }
  }
  check('sourcemap-exposed', '-', maps.slice(0, 5));
  check('no-compression', '-', uncompressed.slice(0, 5));
  check('no-cache-control', '-', noCache.slice(0, 5));

  // ---------- WordPress ----------
  const isWp = datas.some((d) => /wp-content|wp-includes/.test(d.html));
  if (isWp) {
    const users = await fetchText(new URL('/wp-json/wp/v2/users', opts.base).href);
    const exposedUsers: string[] = [];
    if (users && users.status === 200) {
      try {
        const list = JSON.parse(users.body) as Array<{ slug?: string }>;
        if (Array.isArray(list) && list.length > 0) exposedUsers.push(`/wp-json/wp/v2/users で ${list.map((u) => u.slug).filter(Boolean).slice(0, 3).join(', ')} が取得できる`);
      } catch {
        /* 無視 */
      }
    }
    const author = await raw(new URL('/?author=1', opts.base).href);
    const loc = author?.headers.get('location') ?? '';
    if (author && author.status >= 300 && author.status < 400 && /\/author\//.test(loc)) exposedUsers.push(`/?author=1 が ${snippet(loc.replace(opts.base.origin, ''), 40)} へリダイレクトする`);
    check('wp-user-exposed', '-', exposedUsers);
    const x = await raw(new URL('/xmlrpc.php', opts.base).href, { method: 'POST', body: '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName></methodCall>', headers: { 'content-type': 'text/xml' } });
    const xb = x ? await x.text().catch(() => '') : '';
    check('wp-xmlrpc', '-', x && x.status === 200 && /methodResponse/.test(xb) ? ['/xmlrpc.php が応答する'] : []);
  }

  // ---------- npm audit ----------
  const dir = opts.project;
  if (dir && existsSync(path.join(dir, 'package.json'))) {
    if (!existsSync(path.join(dir, 'package-lock.json'))) {
      add('npm-audit-failed', '-', 'package-lock.json がない（pnpm・yarn の場合は、それぞれの audit コマンドで確認する）');
    } else {
      const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json', '--omit=dev'], { cwd: dir, encoding: 'utf8', timeout: 90000, shell: process.platform === 'win32' });
      try {
        const j = JSON.parse(r.stdout) as { metadata?: { vulnerabilities?: Record<string, number> } };
        const v = j.metadata?.vulnerabilities;
        if (!v) throw new Error('結果を読めません');
        if ((v['high'] ?? 0) + (v['critical'] ?? 0) > 0) add('npm-audit', '-', `critical ${v['critical'] ?? 0} / high ${v['high'] ?? 0} / moderate ${v['moderate'] ?? 0}（本番用の依存のみ）`);
        else bumpPass();
      } catch (e) {
        add('npm-audit-failed', '-', snippet((r.stderr || (e as Error).message || '').split('\n')[0] ?? '', 100));
      }
    }
  }
}
