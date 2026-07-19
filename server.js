const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const { spawnSync, spawn } = require('child_process');

const AUDIO_SINK_NAME = process.env.AUDIO_SINK_NAME || 'virtual_mic';
const OUTPUT_SAMPLE_RATE = 48000;
const OUTPUT_CHANNELS = 1;

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
      const moduleName = parts[1] || '';
      const args = parts.slice(2).join('\t');
      if (
        moduleName === 'module-null-sink' &&
        (args.includes(`sink_name=${AUDIO_SINK_NAME}`) || args.includes('device.description=VirtualMic'))
      ) {
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

// Incoming mic audio arrives as compressed WebM/Opus chunks (MediaRecorder output).
// ffmpeg decodes+resamples that stream to a fixed raw PCM format; its stdout is
// fanned out to (a) pacat, which plays it into the virtual mic sink, and
// (b) any connected speaker clients, who already expect raw s16le PCM.
let ffmpegProcess = null;
let pacatProcess = null;

function startAudioPipe() {
  if (ffmpegProcess) return;
  if (!commandExists('ffmpeg')) {
    console.warn('ffmpeg not found; cannot decode incoming mic audio.');
    return;
  }
  if (!commandExists('pacat')) {
    console.warn('pacat not found; virtual mic audio pipe will not be started.');
    return;
  }

  console.log(`Starting audio pipe: ffmpeg (webm/opus -> s16le ${OUTPUT_SAMPLE_RATE}Hz ${OUTPUT_CHANNELS}ch) -> pacat`);
  ffmpegProcess = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', 'webm',
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', String(OUTPUT_SAMPLE_RATE),
    '-ac', String(OUTPUT_CHANNELS),
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'inherit'] });

  pacatProcess = spawn('pacat', [
    '--raw',
    `--channels=${OUTPUT_CHANNELS}`,
    `--rate=${OUTPUT_SAMPLE_RATE}`,
    '--format=s16le',
    '--playback',
    `--device=${AUDIO_SINK_NAME}`,
  ], { stdio: ['pipe', 'ignore', 'inherit'] });

  ffmpegProcess.stdout.on('data', (chunk) => {
    if (pacatProcess && pacatProcess.stdin.writable) pacatProcess.stdin.write(chunk);
    broadcastSpeaker(chunk);
  });

  const onExit = (label) => (code, signal) => {
    console.log(`${label} exited (${signal || code})`);
    stopAudioPipe();
  };
  ffmpegProcess.on('exit', onExit('ffmpeg'));
  ffmpegProcess.on('error', (err) => { console.warn('ffmpeg failed:', err.message || err); stopAudioPipe(); });
  pacatProcess.on('exit', onExit('pacat'));
  pacatProcess.on('error', (err) => { console.warn('pacat failed:', err.message || err); stopAudioPipe(); });
}

function stopAudioPipe() {
  if (ffmpegProcess) { try { ffmpegProcess.kill('SIGTERM'); } catch (e) { /* ignore */ } ffmpegProcess = null; }
  if (pacatProcess) { try { pacatProcess.kill('SIGTERM'); } catch (e) { /* ignore */ } pacatProcess = null; }
}

function cleanupOnExit() {
  process.on('SIGINT', () => {
    console.log('SIGINT received, cleaning up virtual mic');
    stopAudioPipe();
    cleanupVirtualSink();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, cleaning up virtual mic');
    stopAudioPipe();
    cleanupVirtualSink();
    process.exit(0);
  });
  process.on('exit', () => {
    console.log('Process exiting, cleaning up virtual mic');
    stopAudioPipe();
    cleanupVirtualSink();
  });
}

cleanupOnExit();

const speakerClients = new Set();

function broadcastSpeaker(data, excludeWs = null) {
  for (const ws of speakerClients) {
    if (ws === excludeWs) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastFormat() {
  const format = {
    action: 'format',
    sampleRate: OUTPUT_SAMPLE_RATE,
    channels: OUTPUT_CHANNELS,
  };
  for (const ws of speakerClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(format));
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

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, req) => {
  console.log('WebSocket connected', req.socket.remoteAddress);
  const roles = { mic: false, speaker: false };
  let registered = false;

  function registerRoles(roleNames) {
    const list = Array.isArray(roleNames) ? roleNames : [roleNames];
    list.forEach((role) => {
      if (role === 'speaker' && !roles.speaker) {
        roles.speaker = true;
        speakerClients.add(ws);
        console.log('Speaker role registered', req.socket.remoteAddress);
      }
      if (role === 'mic' && !roles.mic) {
        roles.mic = true;
        console.log('Mic role registered', req.socket.remoteAddress);
      }
    });
    registered = true;
    if (roles.mic && !ffmpegProcess) {
      startAudioPipe();
    }
    if (speakerClients.size > 0) {
      broadcastFormat();
    }
  }

  ws.on('message', (message) => {
    const isString = typeof message === 'string' || message instanceof String;
    if (isString) {
      const text = message.toString();
      try {
        const data = JSON.parse(text);
        if (data && data.action === 'register' && Array.isArray(data.roles)) {
          registerRoles(data.roles);
          return;
        }
      } catch (e) {
        // not JSON, continue
      }
      if (!registered) {
        if (text === 'speaker' || text === 'mic') {
          registerRoles(text);
          return;
        }
      }
    }

    if (!registered) {
      registerRoles('mic');
    }

    if (roles.mic) {
      if (!Buffer.isBuffer(message)) message = Buffer.from(message);
      if (ffmpegProcess && ffmpegProcess.stdin.writable) ffmpegProcess.stdin.write(message);
    }
  });

  ws.on('close', () => {
    if (roles.speaker) {
      speakerClients.delete(ws);
      console.log('Speaker client disconnected', req.socket.remoteAddress);
    }
    console.log('Client disconnected', req.socket.remoteAddress);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Server cannot start.`);
  } else {
    console.error('Server error:', err);
  }
  cleanupVirtualSink();
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP+WS server listening on all interfaces at http://0.0.0.0:${PORT}`);
  console.log(`Use this machine IP to connect from other devices: http://<your-ip>:${PORT}`);
  createVirtualSink();
  createSpeakerMonitor();
});
