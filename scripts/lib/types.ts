export type Severity = 'fix' | 'decide' | 'review' | 'manual';
export type Profile = 'quick' | 'standard' | 'full';

export interface CheckDef {
  /** 同じ原因の指摘を1項目にまとめるためのキー。未指定ならIDそのもの */
  group?: string;
  severity: Severity;
  title: string;
  why: string;
  fix: string;
  wcag?: string;
}

export interface Occurrence {
  page: string;
  excerpt?: string;
  /** 目視確認用の証跡ファイル（スクリーンショット、PDFなど）。出力ディレクトリからの相対パス */
  file?: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  why: string;
  fix: string;
  wcag?: string;
  occurrences: Occurrence[];
}

export interface Options {
  base: URL;
  pages: string[];
  max: number;
  /** 出力ディレクトリ（絶対パス） */
  out: string;
  browser: boolean;
  checkExternal: boolean;
  profile: Profile;
  /** ブラウザで重い検査を行う代表ページの数 */
  deepPages: number;
  /** 検査対象プロジェクトのディレクトリ（npm audit などに使う） */
  project?: string;
  /** Lighthouse を省略する */
  noLighthouse: boolean;
}
