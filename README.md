# Endless Blocks

An endless flight over an infinite, procedurally generated blocky world — inspired by the never-ending zoom of organiccity.org.
The camera flies on autopilot forever; you only choose the pace.

## 操作

| 操作 | 動作 |
|---|---|
| Space | 再生 / 停止 |
| ↑ / ↓ (長押し) | 加速 / 減速・後退 |
| ホイール | 速度の微調整 |
| 速度スライダー | 左側は後退。ダブルクリックで既定速度 (8 m/s) |
| F | フルスクリーン |
| M | 環境音 ON/OFF (初期 OFF) |
| H | UI を隠す |
| N | 新しいワールド |
| I | デバッグ情報 (fps, チャンク数など) |

URL パラメータ:

| パラメータ | 意味 | 既定値 |
|---|---|---|
| `seed` | ワールドのシード (同じ値なら同じ世界・同じ飛行経路) | ランダム |
| `speed` | 初期速度 [blocks/s] | 8 |
| `rd` | 描画距離 [チャンク] | 12 |
| `daylen` | 1 日の長さ [秒] | 1200 |
| `time` | 開始時刻 (0 = 日の出, 0.25 = 正午, 0.5 = 日没) | 0.08 |
| `debug` | デバッグ表示 | — |

## 開発

```sh
npm install
npm run dev       # http://localhost:5173
npm test          # 生成の決定性・メッシュ・経路の安全性テスト
npm run build     # dist/ に静的ファイルを出力 (どこにでも置ける。特別なヘッダは不要)
npx vite preview  # ビルド結果の確認
```

## 仕組み

- `src/gen/`: 決定的なワールド生成。マルチノイズの気候 (温度・湿度・大陸性・侵食・奇妙さ) からバイオーム 38 種を選び、3D 密度関数、チーズ洞窟とスパゲッティ洞窟、サーフェスルール、木と植物、村・ピラミッド・塔を生成する。
- `src/workers/`: owner ワーカー 1 つがチャンクを保持し、compute ワーカー N 個が生成と光計算・メッシュ化を担う。planner ワーカーは飛行経路を計画する。
- `src/autopilot/`: 経路はシードだけで決まり、地形と木と建物の高さを常に上回る。カメラの状態は弧長 `s` だけなので、後退すると正確に同じ道を戻る。
- `src/render/`: 自作の GLSL3 シェーダーで描画する。スムースライティングと AO、手続き生成の 16px テクスチャ配列、空、雲、霧、昼夜、天候を持つ。fps が足りないときは解像度と描画距離を自動で下げる。

テクスチャ、名称、音はすべてオリジナル (コードで生成) で、既存ゲームのアセットは使っていない。
