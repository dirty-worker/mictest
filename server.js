const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const FIFO = process.env.AUDIO_FIFO || '/tmp/audio_fifo';
const { spawnSync, spawn } = require('child_process');

function ensureFifo(path) {
  if (fs.existsSync(path)) {
    const stat = fs.statSync(path);
    if (!stat.isFIFO()) {
      console.error(`既存パスが FIFO ではありません: ${path}`);
      process.exit(1);
    }
    return;
  }

  console.log(`FIFO が見つかりません。自動作成します: ${path}`);
  const result = spawnSync('mkfifo', [path]);
  if (result.error) {
    console.error('mkfifo の実行に失敗しました:', result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error('mkfifo が非ゼロ終了コードで終了しました:', result.status);
    console.error(result.stderr.toString());
    process.exit(1);
  }
}

ensureFifo(FIFO);

const AUDIO_SINK_NAME = process.env.AUDIO_SINK_NAME || 'virtual_mic';

function runCmd(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : '';
    throw new Error(`${cmd} ${args.join(' ')} failed: ${stderr}`);
  }
  return result.stdout.toString();
}

function commandExists(cmd) {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function cleanupVirtualSink() {
  if (!commandExists('pactl')) return;
  try {
    const modules = runCmd('pactl', ['list', 'short', 'modules']);
    const lines = modules.split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split('\t');
      const index = parts[0];
      const args = parts[1] || '';
      if (args.includes(`sink_name=${AUDIO_SINK_NAME}`) || args.includes(`device.description=VirtualMic`)) {
        console.log(`Unload existing virtual mic module ${index}`);
        runCmd('pactl', ['unload-module', index]);
      }
    }
  } catch (e) {
    console.warn('virtual mic cleanup failed:', e.message);
  }
}

function createVirtualSink() {
  if (!commandExists('pactl')) {
    console.warn('pactl not found; virtual mic will not be generated automatically.');
    return;
  }
  try {
    cleanupVirtualSink();
    console.log(`Creating virtual mic sink: ${AUDIO_SINK_NAME}`);
    runCmd('pactl', ['load-module', 'module-null-sink', `sink_name=${AUDIO_SINK_NAME}`, 'sink_properties=device.description=VirtualMic']);
    console.log(`Virtual mic created: ${AUDIO_SINK_NAME}`);
  } catch (e) {
    console.warn('Could not create virtual mic:', e.message);
  }
}

function createSpeakerMonitor() {
  if (!commandExists('pactl')) {
    console.warn('pactl not found; speaker monitor will not be generated automatically.');
    return;
  }
  try {
    const monitorName = `${AUDIO_SINK_NAME}.monitor`;
    const sources = runCmd('pactl', ['list', 'short', 'sources']).split('\n').filter(Boolean);
    const hasMonitor = sources.some((line) => line.includes(monitorName));
    if (!hasMonitor) {
      console.log('Speaker monitor not found; using default sink monitor.');
    }
  } catch (e) {
    console.warn('Could not verify speaker monitor:', e.message);
  }
}

createVirtualSink();
createSpeakerMonitor();

const fifoStream = fs.createWriteStream(FIFO);
const speakerClients = new Set();

function broadcastSpeaker(data) {
  for (const ws of speakerClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

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

const wss = new WebSocket.Server({ noServer: true });
const speakerWss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { url } = request;
  if (url === '/speaker') {
    speakerWss.handleUpgrade(request, socket, head, (ws) => {
      speakerWss.emit('connection', ws, request);
    });
  } else {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

wss.on('connection', (ws, req) => {
  console.log('Client connected', req.socket.remoteAddress);
  ws.on('message', (message) => {
    if (!Buffer.isBuffer(message)) message = Buffer.from(message);
    fifoStream.write(message);
  });
  ws.on('close', () => console.log('Client disconnected'));
});

speakerWss.on('connection', (ws, req) => {
  console.log('Speaker client connected', req.socket.remoteAddress);
  speakerClients.add(ws);
  ws.on('close', () => {
    speakerClients.delete(ws);
    console.log('Speaker client disconnected');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP+WS server listening on all interfaces at http://0.0.0.0:${PORT}`);
  console.log(`Use this machine IP to connect from other devices: http://<your-ip>:${PORT}`);
  console.log(`Writing audio data to FIFO: ${FIFO}`);
});
