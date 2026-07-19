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
