#!/usr/bin/env node
/**
 * web-site-check: 初期設定スクリプト
 *
 * 依存パッケージなしで動く（npm install の前でも実行できる）。
 *
 *   node setup.mjs --check [--profile full]       導入状況をJSONで出力する（何もインストールしない）
 *   node setup.mjs --install [--profile full]     足りないものを導入する
 *   node setup.mjs --install --skip-browser       npmパッケージだけ導入し、ブラウザは入れない
 *   node setup.mjs --install --chromium-only      ブラウザはChromiumだけ入れる（フルでもWebKit・Firefoxを入れない）
 *
 * 導入するもの:
 *   npmパッケージ（cheerio, html-validate, playwright, lighthouse など） … このフォルダの node_modules に入る
 *   Chromium（約150MB）                                                  … Playwrightの既定の場所に入る
 *   WebKit・Firefox（各約100MB。フルのときだけ）                         … 同上
 *
 * 終了コード: 0 = 成功 / 1 = npmパッケージの導入に失敗 / 2 = ブラウザの導入に失敗（検査は続行できる）
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const isWin = process.platform === 'win32';
const profileIdx = args.indexOf('--profile');
const profile = profileIdx >= 0 ? args[profileIdx + 1] : 'quick';
const wantEngines = profile === 'full' && !args.includes('--chromium-only');

/** 検査に必須のパッケージ（これが無いと check.ts を実行できない） */
function requiredInstalled() {
  return ['cheerio', 'html-validate', 'tsx', 'playwright'].every((m) => existsSync(path.join(dir, 'node_modules', m)));
}

function lighthouseInstalled() {
  return existsSync(path.join(dir, 'node_modules', 'lighthouse'));
}

/** ブラウザの実体があるか。PLAYWRIGHT_BROWSERS_PATH も考慮される */
function engineInstalled(name) {
  try {
    const require = createRequire(path.join(dir, 'package.json'));
    const pw = require('playwright');
    return existsSync(pw[name].executablePath());
  } catch {
    return false;
  }
}

function status() {
  const deps = requiredInstalled();
  const st = {
    deps,
    lighthouse: deps && lighthouseInstalled(),
    browser: deps && engineInstalled('chromium'),
    webkit: deps && engineInstalled('webkit'),
    firefox: deps && engineInstalled('firefox'),
    needs: [],
  };
  if (!deps || !st.lighthouse) st.needs.push('npm-packages');
  if (!st.browser) st.needs.push('chromium');
  if (wantEngines && !st.webkit) st.needs.push('webkit');
  if (wantEngines && !st.firefox) st.needs.push('firefox');
  return st;
}

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: dir, stdio: 'inherit', shell: isWin });
  return r.status === 0;
}

if (args.includes('--check')) {
  console.log(JSON.stringify(status()));
  process.exit(0);
}

if (args.includes('--install')) {
  const before = status();

  if (before.needs.includes('npm-packages')) {
    console.log('npmパッケージを導入します（cheerio, html-validate, playwright, lighthouse など）...');
    if (!run('npm', ['install', '--no-audit', '--no-fund'])) {
      console.error('npmパッケージの導入に失敗しました。ネットワークとNode.jsのバージョン（18以上）を確認してください。');
      process.exit(1);
    }
  }

  let browserFailed = false;
  if (!args.includes('--skip-browser')) {
    const engines = [];
    if (!engineInstalled('chromium')) engines.push('chromium');
    if (wantEngines && !engineInstalled('webkit')) engines.push('webkit');
    if (wantEngines && !engineInstalled('firefox')) engines.push('firefox');
    for (const e of engines) {
      console.log(`${e} を導入します...`);
      if (!run('npx', ['--no-install', 'playwright', 'install', e])) {
        browserFailed = true;
        console.error(`${e} の導入に失敗しました。`);
      }
    }
    if (browserFailed) {
      console.error('Chromiumがなければ --no-browser で、ブラウザを使わない検査だけ実行できます。WebKit・Firefoxがなければ、その検査だけ省略されます。');
      console.error('Linuxで起動に失敗する場合は、システムのライブラリが不足している可能性があります（npx playwright install-deps）。');
    }
  }

  console.log(JSON.stringify(status()));
  process.exit(browserFailed ? 2 : 0);
}

console.error('使い方: node setup.mjs --check [--profile full] | --install [--profile full] [--skip-browser] [--chromium-only]');
process.exit(1);
