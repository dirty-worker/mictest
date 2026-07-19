(() => {
  const status = document.getElementById('status');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const modeSelect = document.getElementById('modeSelect');
  const micSelect = document.getElementById('micSelect');
  const emitCheckbox = document.getElementById('emit');
  const volumeInput = document.getElementById('volume');
  const volumeValue = document.getElementById('volumeValue');
  const canvas = document.getElementById('viz');
  const ctx = canvas.getContext('2d');
  const requestPermBtn = document.getElementById('requestPerm');
  const permStatus = document.getElementById('permStatus');
  let audioCtx, processor, source, stream, ws, analyser, gainNode, drawId, monitorConnected = false;
  let speakerSource;

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
      const devices = navigator.mediaDevices && navigator.mediaDevices.enumerateDevices ? await navigator.mediaDevices.enumerateDevices() : [];
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

  async function updatePermissionStatus() {
    try {
      if (!navigator.permissions) { permStatus.textContent = '権限: 不明 (Permissions API 未対応)'; return; }
      const status = await navigator.permissions.query({ name: 'microphone' });
      permStatus.textContent = '権限: ' + status.state;
      status.onchange = () => { permStatus.textContent = '権限: ' + status.state; };
    } catch (e) {
      permStatus.textContent = '権限: 確認不可';
    }
  }

  function hasGetUserMedia() {
    return !!((navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia);
  }

  function getUserMediaCompat(constraints) {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }
    const getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
    if (!getUserMedia) return Promise.reject(new Error('getUserMedia is not implemented in this browser'));
    return new Promise((resolve, reject) => getUserMedia.call(navigator, constraints, resolve, reject));
  }

  async function requestMicrophonePermission() {
    try {
      if (!hasGetUserMedia()) throw new Error('getUserMedia not supported');
      await getUserMediaCompat({ audio: true });
      await enumerateInputs();
      updatePermissionStatus();
      status.textContent = 'マイク権限が付与されました';
    } catch (e) {
      status.textContent = 'マイク権限が拒否されました';
      console.warn('getUserMedia denied', e);
    }
  }

  requestPermBtn.addEventListener('click', requestMicrophonePermission);
  volumeInput.addEventListener('input', () => {
    const value = parseFloat(volumeInput.value);
    volumeValue.textContent = value.toFixed(2);
    if (gainNode) gainNode.gain.value = value;
  });
  updatePermissionStatus();

  startBtn.onclick = async () => {
    try {
      ws = new WebSocket(getWsUrl());
      ws.binaryType = 'arraybuffer';
      ws.onopen = async () => {
        status.textContent = 'WebSocket 接続済み';
        const mode = modeSelect.value;
        ws.send(mode);

        if (mode === 'speaker') {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          gainNode = audioCtx.createGain();
          gainNode.gain.value = parseFloat(volumeInput.value);
          gainNode.connect(audioCtx.destination);

          const bufferQueue = [];
          let sourceNode = null;

          ws.onmessage = (event) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            const float32 = new Float32Array(event.data.byteLength / 2);
            const view = new DataView(event.data);
            for (let i = 0; i < float32.length; i++) {
              const s = view.getInt16(i * 2, true);
              float32[i] = s / 0x7fff;
            }
            bufferQueue.push(float32);
            if (!sourceNode) {
              sourceNode = audioCtx.createBufferSource();
              const buffer = audioCtx.createBuffer(1, float32.length, audioCtx.sampleRate);
              buffer.copyToChannel(float32, 0);
              sourceNode.buffer = buffer;
              sourceNode.connect(gainNode);
              sourceNode.start();
              sourceNode.onended = () => { sourceNode = null; };
            }
          };

          startBtn.disabled = true;
          stopBtn.disabled = false;
          status.textContent = 'Speaker mode ready';
          return;
        }

        const constraints = { audio: {} };
        const deviceId = micSelect.value;
        if (deviceId) constraints.audio.deviceId = { exact: deviceId };
        if (!hasGetUserMedia()) throw new Error('getUserMedia not supported in this browser / context');
        stream = await getUserMediaCompat(constraints);
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        source = audioCtx.createMediaStreamSource(stream);
        gainNode = audioCtx.createGain();
        gainNode.gain.value = parseFloat(volumeInput.value);

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        source.connect(gainNode);

        processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          const pcm = floatTo16BitPCM(input);
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);

        if (emitCheckbox.checked) {
          try { gainNode.connect(audioCtx.destination); monitorConnected = true; } catch (e) { console.warn(e); }
        }

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
    if (speakerSource) { try { speakerSource.disconnect(); } catch {} speakerSource = null; }
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
