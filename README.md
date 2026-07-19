# Mic → WebSocket → 仮想マイク 使い方

このリポジトリはブラウザからマイク入力を取得し、`MediaRecorder`（Opus/WebM）で圧縮しつつ WebSocket 経由で Node.js サーバーへ送り、サーバー側で `ffmpeg` により生の PCM（48000Hz, モノラル, s16le）へデコード・リサンプルした上で `pacat` を使って PulseAudio の仮想マイク（`module-null-sink`）へ再生する例です。

セットアップ手順（Linux）:

1. 依存パッケージをインストールします:

```bash
# npm または pnpm をお使いください
npm install ws

# ffmpeg と PulseAudio クライアント（pactl/pacat）が必要です
sudo apt install ffmpeg pulseaudio-utils
```

2. サーバーを起動します:

```bash
node server.js
```

起動時にサーバーが仮想マイクシンク（デフォルト名 `virtual_mic`、環境変数 `AUDIO_SINK_NAME` で変更可）を自動作成します。

3. ブラウザで開きます:

http://localhost:8080

4. マイク（他のアプリ）として `virtual_mic.monitor` を選択すると、ブラウザから送られた音声を利用できます。

仕組み:
- クライアントは `MediaRecorder` でマイク入力を Opus/WebM チャンクにエンコードし、WebSocket でサーバーへ送信します。手動での PCM 変換やサンプルレートの手動指定は行いません。
- サーバーはチャンクを `ffmpeg` の標準入力へ連続してパイプし、`ffmpeg` が固定フォーマット（48000Hz, モノラル, 16bit PCM リトルエンディアン）へデコード・リサンプルします。クライアント側マイクの実際のサンプルレートに関わらず、常にこの固定フォーマットへ変換されるため、フォーマット不一致によるノイズが発生しません。
- デコード後の PCM は `pacat` へ渡され仮想マイクシンクに再生されると同時に、Speaker モードで接続しているブラウアクライアントへもそのまま配信され、そちらは受信 PCM をそのまま `AudioBufferSourceNode` で再生します。

注意点:
- ブラウザはセキュアコンテキスト（localhost を含む）で getUserMedia が動作します。
- `ffmpeg` と `pacat` が `PATH` 上に無い場合、サーバーは警告を出して音声パイプを起動しません。
