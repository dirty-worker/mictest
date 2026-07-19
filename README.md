# Mic → WebSocket → FIFO 使い方

このリポジトリはブラウザからマイク入力を取得し、WebSocket 経由で Node.js サーバーへ送り、サーバー側で FIFO（named pipe）へ書き込む例です。

セットアップ手順（Linux）:

1. FIFO を作成します（例）:

```bash
mkfifo /tmp/audio_fifo
```

2. 依存をインストールします（`ws`）:

```bash
# npm または pnpm をお使いください
npm install ws
```

3. サーバーを起動します:

```bash
AUDIO_FIFO=/tmp/audio_fifo node server.js
```

4. ブラウザで開きます:

http://localhost:8080

5. FIFO の中身を再生する例（サンプルレートはブラウザの AudioContext に依存、多くは 48000）:

```bash
# aplay を使う（モノラル 16bit PCM, 48000Hz の例）
aplay -f S16_LE -c1 -r 48000 /tmp/audio_fifo

# ffplay を使う場合
ffplay -f s16le -ar 48000 -ac 1 /tmp/audio_fifo
```

注意点:
- ブラウザはセキュアコンテキスト（localhost を含む）で getUserMedia が動作します。
- 送信されるデータは 16bit リトルエンディアン PCM（モノラル）です。再生側はサンプルレートを合わせてください。

自動で再生コマンドを起動する
-------------------------------------------------
サーバー起動時に `tail -f` と再生コマンド（`paplay` など）を子プロセスとして自動で起動することができます。これにより別ターミナルで `tail -f` を実行する手間が不要になります。

デフォルトではサーバーは次のコマンドを実行します（必要に応じて環境変数 `AUDIO_CMD` で上書きできます）:

```sh
tail -f /tmp/audio_fifo | paplay --device=virtual_mic --raw --format=s16ne --rate=48000 --channels=1
```

起動例:

```bash
# FIFO を作成
mkfifo /tmp/audio_fifo

# 必要パッケージをインストール
npm install ws

# 環境変数でコマンドを変更する例（任意）
export AUDIO_CMD="tail -f /tmp/audio_fifo | ffplay -f s16le -ar 48000 -ac 1 -"

# サーバーを起動（デフォルトで AUDIO_CMD が実行されます）
AUDIO_FIFO=/tmp/audio_fifo node server.js
```

エラー出力はサーバーのログに表示されます。
