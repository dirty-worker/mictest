(() => {
  const status = document.getElementById('status');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const micSelect = document.getElementById('micSelect');
  const emitCheckbox = document.getElementById('emit');
  const canvas = document.getElementById('viz');
  const ctx = canvas.getContext('2d');
  let audioCtx, processor, source, stream, ws, analyser, drawId, monitorConnected = false;

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

  async function enumerateInputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      micSelect.innerHTML = '';
      inputs.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microphone ${micSelect.length + 1}`;
        micSelect.appendChild(opt);
      });
    } catch (e) {
      console.warn('enumerateDevices failed', e);
    }
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', enumerateInputs);
  } else if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
    navigator.mediaDevices.ondevicechange = enumerateInputs;
  }
  // 初回列挙
  enumerateInputs();

  startBtn.onclick = async () => {
    try {
      ws = new WebSocket(getWsUrl());
      ws.binaryType = 'arraybuffer';
      ws.onopen = async () => {
        status.textContent = 'WebSocket 接続済み';
        const constraints = { audio: {} };
        const deviceId = micSelect.value;
        if (deviceId) constraints.audio.deviceId = { exact: deviceId };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        source = audioCtx.createMediaStreamSource(stream);

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);

        processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          const pcm = floatTo16BitPCM(input);
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
        };
        // processor は分析のためソースへ接続（出力は使わない）
        source.connect(processor);
        processor.connect(audioCtx.destination); // 必要ないが ScriptProcessor が止まらないように一旦接続

        // モニター（ローカル再生）の切替
        if (emitCheckbox.checked) {
          try { source.connect(audioCtx.destination); monitorConnected = true; } catch (e) { console.warn(e); }
        }

        // 可視化ループ
        const bufferLength = analyser.fftSize;
        const dataArray = new Uint8Array(bufferLength);
        function draw() {
          drawId = requestAnimationFrame(draw);
          analyser.getByteTimeDomainData(dataArray);
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#007acc';
          ctx.beginPath();
          const sliceWidth = canvas.width / bufferLength;
          let x = 0;
          for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = (v * canvas.height) / 2;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
          }
          ctx.lineTo(canvas.width, canvas.height / 2);
          ctx.stroke();
        }
        draw();

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
    if (drawId) { cancelAnimationFrame(drawId); drawId = null; }
    if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
    if (processor) { try { processor.disconnect(); } catch {} processor.onaudioprocess = null; processor = null; }
    if (source) { try { if (monitorConnected) source.disconnect(audioCtx.destination); source.disconnect(); } catch {} source = null; }
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    status.textContent = '停止';
  };

  // マイク選択変更時、録音中なら再起動
  micSelect.addEventListener('change', () => {
    if (stream) { stopBtn.onclick(); startBtn.click(); }
  });

  // Emit トグルでモニターON/OFF
  emitCheckbox.addEventListener('change', () => {
    if (!audioCtx || !source) return;
    if (emitCheckbox.checked) { try { source.connect(audioCtx.destination); monitorConnected = true; } catch (e) { console.warn(e); } }
    else { try { source.disconnect(audioCtx.destination); monitorConnected = false; } catch (e) { /* ignore */ } }
  });

})();
