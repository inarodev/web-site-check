# クイック

納品前・公開前に最低限見るべき項目を、数分で確認するプロファイル。

## 目安

- 時間：数分（最大20ページ）
- トークン：少ない（検査はスクリプトが行い、Claudeはレポートの整形と修正の相談に使う）

## 内容

| 領域 | 内容 |
| --- | --- |
| HTML構造 | 構文エラー（閉じタグ忘れ・不正なネスト・ID重複）、`lang`、`title`、`main`、h1の数、見出し階層、空の `span`/`div`、`div`/`span` へのクリック処理 |
| meta・SEO | `description`、`viewport` とズーム禁止、OGP画像の有無・実在・絶対URL、`twitter:card`、`canonical`、favicon、`apple-touch-icon`、`hreflang` の整合 |
| 公開前確認 | `noindex`、`robots.txt`、`sitemap.xml`（仮ドメインの残りを含む）、404の挙動、ダミーテキスト、localhostの残り、開発用コメント、混在コンテンツ、401 |
| 画像 | `alt`、altのファイル名、`width`/`height`、配信形式、表示サイズに対する実寸、重さ、GIF、ページ内の合計 |
| リンク・フォーム | 空リンク、曖昧なリンク文言、名前のないリンク・ボタン、`target="_blank"` の `rel`、`tel:`/`mailto:`、内部リンク切れ、ラベル |
| 読み上げ | 半角カナ、見出し・リンク・ボタン内の全角スペース、HTML上で全て大文字の英単語 |
| 実行時 | コンソールエラー、読み込みに失敗したリソース |

判定の考え方は `checks/quick-checks.md`。
