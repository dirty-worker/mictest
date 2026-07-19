(() => {
  const status = document.getElementById('status');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  let audioCtx, processor, source, stream, ws;

  function floatTo16BitPCM(float32Array) {
    const l = float32Array.length;
    const buffer = new ArrayBuffer(l * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < l; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  function getWsUrl() {
    const loc = window.location;
    return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host;
  }

  startBtn.onclick = async () => {
    try {
      ws = new WebSocket(getWsUrl());
      ws.binaryType = 'arraybuffer';
      ws.onopen = async () => {
        status.textContent = 'WebSocket 接続済み';
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        source = audioCtx.createMediaStreamSource(stream);
        processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          const pcm = floatTo16BitPCM(input);
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
        startBtn.disabled = true;
        stopBtn.disabled = false;
        status.textContent = '録音中… サンプルレート:' + audioCtx.sampleRate;
      };
      ws.onerror = (e) => { console.error(e); status.textContent = 'WebSocket エラー'; };
      ws.onclose = () => { status.textContent = 'WebSocket 切断'; };
    } catch (err) {
      console.error(err);
      status.textContent = 'エラー: ' + err.message;
    }
  };

  stopBtn.onclick = () => {
    if (processor) { try { processor.disconnect(); } catch {} processor.onaudioprocess = null; processor = null; }
    if (source) { try { source.disconnect(); } catch {} source = null; }
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    status.textContent = '停止';
  };

})();
