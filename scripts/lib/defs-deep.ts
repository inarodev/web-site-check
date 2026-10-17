import type { CheckDef } from './types.js';

// 標準・フルで共通に使う定義。各検査モジュール固有の定義は、モジュール側で registerDefs する。
export const DEEP_DEFS: Record<string, CheckDef> = {
  'module-failed': {
    severity: 'manual',
    title: '一部の検査を実行できなかった',
    why: '検査中にエラーが起きたため、この項目は確認できていない。',
    fix: 'エラー内容を確認し、必要なら該当の検査だけ再実行するか、手動で確認する。',
  },
  'deep-browser-skipped': {
    severity: 'manual',
    title: '標準・フルのブラウザ検査を省略した',
    why: 'レイアウト・表示モード・JS無効時・フォーム・ホバーなどの検査にはブラウザが必要。',
    fix: 'Chromiumを導入し、--no-browser を付けずに再実行する。',
  },
  'lighthouse-skipped': {
    severity: 'manual',
    title: 'Lighthouseを省略した',
    why: 'Lighthouseの監査（アクセシビリティ・ベストプラクティス・SEO）を実行していない。',
    fix: 'Lighthouseを導入し、--no-lighthouse を付けずに再実行する。',
  },
};
