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
  const speakerCanvas = document.getElementById('vizSpeaker');
  const speakerCtx = speakerCanvas.getContext('2d');
  const speakerPlaybackCheckbox = document.getElementById('speakerPlayback');
  const requestPermBtn = document.getElementById('requestPerm');
  const permStatus = document.getElementById('permStatus');
  let audioCtx, recorder, processor, source, stream, ws, analyser, gainNode, drawId, monitorConnected = false;
  let speakerSource;
  let analyserSpeaker, speakerDrawId;
  let incomingSampleRate = null;
  let incomingChannels = 1;

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

  const MIC_MIME_TYPE = ['audio/webm;codecs=opus', 'audio/webm']
    .find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type));

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
        const roles = mode === 'both' ? ['mic', 'speaker'] : [mode];
        const speakerMode = roles.includes('speaker');
        const micMode = roles.includes('mic');

        if ((speakerMode || micMode) && !audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        ws.send(JSON.stringify({
          action: 'register',
          roles,
          sampleRate: audioCtx.sampleRate,
          channels: 1,
        }));

        if (speakerMode) {
          if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          gainNode = audioCtx.createGain();
          gainNode.gain.value = parseFloat(volumeInput.value);
          analyserSpeaker = audioCtx.createAnalyser();
          analyserSpeaker.fftSize = 2048;
          analyserSpeaker.connect(gainNode);
          if (speakerPlaybackCheckbox.checked) gainNode.connect(audioCtx.destination);

          const speakerBufferLength = analyserSpeaker.fftSize;
          const speakerDataArray = new Uint8Array(speakerBufferLength);
          function drawSpeaker() {
            speakerDrawId = requestAnimationFrame(drawSpeaker);
            analyserSpeaker.getByteTimeDomainData(speakerDataArray);
            speakerCtx.fillStyle = 'white';
            speakerCtx.fillRect(0, 0, speakerCanvas.width, speakerCanvas.height);
            speakerCtx.lineWidth = 2;
            speakerCtx.strokeStyle = '#cc7a00';
            speakerCtx.beginPath();
            const sliceWidth = speakerCanvas.width / speakerBufferLength;
            let sx = 0;
            for (let i = 0; i < speakerBufferLength; i++) {
              const v = speakerDataArray[i] / 128.0;
              const y = (v * speakerCanvas.height) / 2;
              if (i === 0) speakerCtx.moveTo(sx, y);
              else speakerCtx.lineTo(sx, y);
              sx += sliceWidth;
            }
            speakerCtx.lineTo(speakerCanvas.width, speakerCanvas.height / 2);
            speakerCtx.stroke();
          }
          drawSpeaker();

          let sourceNode = null;

          ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
              try {
                const meta = JSON.parse(event.data);
                if (meta && meta.action === 'format') {
                  incomingSampleRate = meta.sampleRate;
                  incomingChannels = meta.channels || 1;
                }
              } catch (e) {
                // ignore non-JSON text
              }
              return;
            }
            if (!(event.data instanceof ArrayBuffer)) return;
            const float32 = new Float32Array(event.data.byteLength / 2);
            const view = new DataView(event.data);
            for (let i = 0; i < float32.length; i++) {
              const s = view.getInt16(i * 2, true);
              float32[i] = s / 0x7fff;
            }
            const sampleRate = incomingSampleRate || audioCtx.sampleRate;
            if (sourceNode) {
              sourceNode.onended = null;
              sourceNode = null;
            }
            sourceNode = audioCtx.createBufferSource();
            const buffer = audioCtx.createBuffer(1, float32.length, sampleRate);
            buffer.copyToChannel(float32, 0);
            sourceNode.buffer = buffer;
            sourceNode.connect(analyserSpeaker);
            sourceNode.start();
            sourceNode.onended = () => { sourceNode = null; };
          };
        }

        if (!micMode) {
          startBtn.disabled = true;
          stopBtn.disabled = false;
          status.textContent = speakerMode ? 'Speaker mode ready' : '接続済み';
          return;
        }

        const constraints = { audio: {} };
        const deviceId = micSelect.value;
        if (deviceId) constraints.audio.deviceId = { exact: deviceId };
        if (!hasGetUserMedia()) throw new Error('getUserMedia not supported in this browser / context');
        stream = await getUserMediaCompat(constraints);
        source = audioCtx.createMediaStreamSource(stream);
        gainNode = audioCtx.createGain();
        gainNode.gain.value = parseFloat(volumeInput.value);

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        source.connect(gainNode);

        processor = audioCtx.createScriptProcessor(4096, 1, 1);
        source.connect(processor);
        processor.connect(audioCtx.destination);

        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          const pcm = floatTo16BitPCM(input);
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
        };

        if (emitCheckbox.checked) {
          try { source.connect(audioCtx.destination); monitorConnected = true; } catch (e) { console.warn(e); }
        }

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
    if (speakerDrawId) { cancelAnimationFrame(speakerDrawId); speakerDrawId = null; }
    if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
    if (analyserSpeaker) { try { analyserSpeaker.disconnect(); } catch {} analyserSpeaker = null; }
    if (recorder) { try { if (recorder.state !== 'inactive') recorder.stop(); } catch {} recorder.ondataavailable = null; recorder = null; }
    if (source) { try { if (monitorConnected) source.disconnect(audioCtx.destination); source.disconnect(); } catch {} source = null; }
    if (speakerSource) { try { speakerSource.disconnect(); } catch {} speakerSource = null; }
    if (gainNode) { try { gainNode.disconnect(); } catch {} gainNode = null; }
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

  // 受信音声の再生トグル（可視化は継続する）
  speakerPlaybackCheckbox.addEventListener('change', () => {
    if (!audioCtx || !gainNode) return;
    if (speakerPlaybackCheckbox.checked) {
      try { gainNode.connect(audioCtx.destination); } catch (e) { console.warn(e); }
    } else {
      try { gainNode.disconnect(audioCtx.destination); } catch (e) { /* ignore */ }
    }
  });

  // Emit トグルでモニターON/OFF
  emitCheckbox.addEventListener('change', () => {
    if (!audioCtx || !source) return;
    if (emitCheckbox.checked) { try { source.connect(audioCtx.destination); monitorConnected = true; } catch (e) { console.warn(e); } }
    else { try { source.disconnect(audioCtx.destination); monitorConnected = false; } catch (e) { /* ignore */ } }
  });

})();
