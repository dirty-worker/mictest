const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const FIFO = process.env.AUDIO_FIFO || '/tmp/audio_fifo';

if (!fs.existsSync(FIFO)) {
  console.error(`FIFO が見つかりません: ${FIFO}`);
  console.error('事前に mkfifo で作成してください: mkfifo ' + FIFO);
  process.exit(1);
}

const fifoStream = fs.createWriteStream(FIFO);

// --- 自動起動: FIFO を tail して再生コマンドを子プロセスで起動する ---
const { spawn } = require('child_process');
// 環境変数 AUDIO_CMD でコマンドを上書きできます。デフォルトは tail -> paplay の例。
const AUDIO_CMD = process.env.AUDIO_CMD || `tail -f ${FIFO} | paplay --device=virtual_mic --raw --format=s16le --rate=48000 --channels=1`;
try {
  const audioProc = spawn('sh', ['-c', AUDIO_CMD], { cwd: __dirname });
  audioProc.stdout.on('data', (d) => console.log('[audio-cmd stdout]', d.toString()));
  audioProc.stderr.on('data', (d) => console.error('[audio-cmd stderr]', d.toString()));
  audioProc.on('exit', (code, sig) => console.log(`[audio-cmd] exited code=${code} signal=${sig}`));
  console.log('[audio-cmd] started:', AUDIO_CMD);
} catch (err) {
  console.error('Failed to start audio command:', err);
}
// ------------------------------------------------------------------

const publicDir = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(publicDir, decodeURIComponent(reqPath));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.statusCode = 404; res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.js' ? 'application/javascript' : ext === '.html' ? 'text/html' : 'text/css';
    res.setHeader('Content-Type', mime + '; charset=utf-8');
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (ws, req) => {
  console.log('Client connected', req.socket.remoteAddress);
  ws.on('message', (message) => {
    if (!Buffer.isBuffer(message)) message = Buffer.from(message);
    fifoStream.write(message);
  });
  ws.on('close', () => console.log('Client disconnected'));
});

server.listen(PORT, () => {
  console.log(`HTTP+WS server listening http://localhost:${PORT}`);
  console.log(`Writing audio data to FIFO: ${FIFO}`);
});
