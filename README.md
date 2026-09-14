# SLIT Symptom Tracker v0.4.8

舌下免疫療法の服用後に、主観的な局所症状の強さと時間経過を記録する、iPhone向けの静的PWAです。

## 重要事項

- このアプリは診断、医学的な緊急度判定、服薬・休薬判断を行いません。
- 症状の強さ0〜5は主観的な量であり、緊急度とは別です。
- 呼吸が苦しい、声が急に変わった、喉が締まる感じ、舌や喉の急な腫れ、強い咳や喘鳴が続く、ぐったりしている等がある場合は、アプリで経過記録を続けず、処方医から指示された緊急時対応に従ってください。

## Privacy / プライバシー

記録はこの端末内のIndexedDBに保存され、このアプリによってサーバーへ送信されません。端末、ブラウザ、Webサイトデータの削除等により失われることがあります。Parent Modeから定期的にJSONバックアップを保存してください。

Records are stored locally on this device in IndexedDB and are not uploaded to a server by this application. Device, browser, or website-data deletion can remove them. Export JSON backups regularly from Parent Mode.

## 起動

このフォルダーで次を実行します。

```powershell
npm run serve
```

ブラウザで `http://127.0.0.1:4173` を開きます。実機ではHTTPSで静的ホスティングし、iPhone Safariの共有メニューから「ホーム画面に追加」を選びます。

GitHub Pagesなど、サブディレクトリ配信にも対応する相対パス構成です。

## テスト

```powershell
npm test
```

## データモデル

`src/model.js` が状態遷移と派生指標の正本です。`lifecycle` は記録受付状態、`outcome` は記録から導出する症状結果で、別々に扱います。

## Accessibility

44px以上の操作領域、キーボードフォーカス、VoiceOver向けラベル、色以外のスケール表現、`prefers-reduced-motion` を実装しています。公開前にiPhone実機とVoiceOverで確認してください。

## License

公開時にプロジェクト所有者がライセンスを選択してください。
