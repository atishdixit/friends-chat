// DuoCall client: chat over a WebSocket, audio/video calls over WebRTC (peer to peer).

const $ = (id) => document.getElementById(id);
const el = {
  login: $('login'), loginForm: $('login-form'), name: $('name'), password: $('password'), loginError: $('login-error'),
  chat: $('chat'), messages: $('messages'), composer: $('composer'), text: $('text'), typing: $('typing'),
  peerDot: $('peer-dot'), peerName: $('peer-name'), peerStatus: $('peer-status'),
  btnAudio: $('btn-audio'), btnVideo: $('btn-video'), btnLogout: $('btn-logout'),
  incoming: $('incoming'), incomingAvatar: $('incoming-avatar'), incomingTitle: $('incoming-title'),
  btnAccept: $('btn-accept'), btnDecline: $('btn-decline'),
  call: $('call'), remote: $('remote'), local: $('local'),
  callAvatar: $('call-avatar'), callName: $('call-name'), callState: $('call-state'),
  btnMute: $('btn-mute'), btnCam: $('btn-cam'), btnFlip: $('btn-flip'), btnHangup: $('btn-hangup'),
  toast: $('toast')
};

const RING_TIMEOUT_MS = 45000;
const store = {
  get(k, s = localStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k, v, s = localStorage) { try { s.setItem(k, v); } catch {} },
  del(k, s = localStorage) { try { s.removeItem(k); } catch {} }
};

let ws = null;
let me = null;
let creds = null;
let iceServers = [];
let online = [];
let reconnectTimer = null;
let manualClose = false;
let lastDay = null;
let unread = 0;
let call = null; // { pc, stream, video, role, state, peer, pendingIce, ringTimer, startedAt, tick, facing }
let incoming = null; // { from, video, timer }

// ---------- connection ----------
function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => sendWs({ type: 'join', ...creds });
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = () => {
    if (manualClose || !me) return;
    setPeerStatus('Reconnecting…');
    reconnectTimer = setTimeout(connect, 2000);
  };
}

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  switch (msg.type) {
    case 'join-error':
      manualClose = true;
      ws.close();
      me = null;
      showLogin(msg.message);
      break;
    case 'joined':
      me = msg.name;
      iceServers = msg.iceServers || [];
      store.set('duocall.name', me);
      store.set('duocall.creds', JSON.stringify(creds), sessionStorage);
      showChat(msg.history || []);
      break;
    case 'kicked':
      manualClose = true;
      endCall(false);
      me = null;
      showLogin(msg.message);
      break;
    case 'presence':
      online = msg.online;
      updatePeer();
      break;
    case 'chat':
      addMessage(msg);
      if (msg.from !== me) notifyUnread();
      break;
    case 'typing':
      showTyping(msg.from);
      break;
    case 'call': onIncomingCall(msg); break;
    case 'accept': onAccepted(); break;
    case 'decline': if (call) { endCall(false); toast(`${msg.from} declined the call`); } break;
    case 'busy': if (call) { endCall(false); toast(`${msg.from} is on another call`); } break;
    case 'unavailable': if (call) { endCall(false); toast('The other person is not online'); } break;
    case 'hangup': onRemoteHangup(msg); break;
    case 'offer': onOffer(msg); break;
    case 'answer': onAnswer(msg); break;
    case 'ice': onIce(msg); break;
    case 'media': onRemoteMedia(msg); break;
  }
}

// ---------- screens ----------
function showLogin(error = '') {
  el.chat.classList.add('hidden');
  el.login.classList.remove('hidden');
  el.loginError.textContent = error;
  el.name.value = store.get('duocall.name') || el.name.value;
  (el.name.value ? el.password : el.name).focus();
}

function showChat(history) {
  el.login.classList.add('hidden');
  el.chat.classList.remove('hidden');
  el.messages.replaceChildren();
  lastDay = null;
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.id = 'empty';
    empty.textContent = 'No messages yet. Say hi!';
    el.messages.append(empty);
  }
  history.forEach(addMessage);
  const canCall = !!navigator.mediaDevices?.getUserMedia;
  if (!canCall) {
    el.btnAudio.title = el.btnVideo.title = 'Calls need HTTPS (or localhost)';
  }
  updatePeer();
  el.text.focus();
}

function peerName() {
  return online.find((n) => n !== me) || null;
}

function updatePeer() {
  const peer = peerName();
  el.peerDot.classList.toggle('on', !!peer);
  el.peerName.textContent = peer || 'Waiting for the other person…';
  setPeerStatus(peer ? 'Online' : `You are signed in as ${me}`);
  const canCall = !!peer && !!navigator.mediaDevices?.getUserMedia;
  el.btnAudio.disabled = el.btnVideo.disabled = !canCall;
}

function setPeerStatus(text) {
  el.peerStatus.textContent = text;
}

// ---------- chat ----------
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function addDay(date) {
  const day = date.toDateString();
  if (day === lastDay) return;
  lastDay = day;
  const d = document.createElement('div');
  d.className = 'day';
  d.textContent = day === new Date().toDateString() ? 'Today' : dayFmt.format(date);
  el.messages.append(d);
}

function addMessage(m) {
  $('empty')?.remove();
  const date = new Date(m.at);
  addDay(date);
  const div = document.createElement('div');
  div.className = 'msg' + (m.from === me ? ' mine' : '');
  div.textContent = m.text;
  const t = document.createElement('time');
  t.dateTime = m.at;
  t.textContent = timeFmt.format(date);
  div.append(t);
  el.messages.append(div);
  el.typing.textContent = '';
  scrollDown();
}

function addSystem(text) {
  $('empty')?.remove();
  const div = document.createElement('div');
  div.className = 'system';
  div.textContent = text;
  el.messages.append(div);
  scrollDown();
}

function scrollDown() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

let typingHide = null;
function showTyping(name) {
  el.typing.textContent = `${name} is typing…`;
  clearTimeout(typingHide);
  typingHide = setTimeout(() => (el.typing.textContent = ''), 3000);
}

let lastTypingSent = 0;
el.text.addEventListener('input', () => {
  const now = Date.now();
  if (el.text.value && now - lastTypingSent > 2000) {
    lastTypingSent = now;
    sendWs({ type: 'typing' });
  }
});

el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.text.value.trim();
  if (!text) return;
  sendWs({ type: 'chat', text });
  el.text.value = '';
  lastTypingSent = 0;
});

function notifyUnread() {
  if (!document.hidden) return;
  unread++;
  document.title = `(${unread}) DuoCall`;
  beep(880, 0.08);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    unread = 0;
    document.title = 'DuoCall';
  }
});

// ---------- sounds (generated, no files) ----------
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}
function beep(freq, dur, when = 0, vol = 0.15) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = freq;
  g.gain.value = vol;
  o.connect(g).connect(audioCtx.destination);
  const t = audioCtx.currentTime + when;
  o.start(t);
  o.stop(t + dur);
}
let ringLoop = null;
function startRing(outgoing) {
  stopRing();
  const play = () => (outgoing ? beep(440, 0.9, 0, 0.08) : (beep(740, 0.25), beep(620, 0.25, 0.3)));
  play();
  ringLoop = setInterval(play, outgoing ? 3000 : 1600);
}
function stopRing() {
  clearInterval(ringLoop);
  ringLoop = null;
}

// ---------- calls ----------
async function getMedia(video, facing = 'user') {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: video ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false
  });
}

function mediaError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError') return 'Microphone/camera permission was blocked';
  if (name === 'NotFoundError') return 'No microphone or camera found';
  if (name === 'NotReadableError') return 'Microphone or camera is in use by another app';
  return 'Could not start microphone/camera';
}

async function startCall(video) {
  const peer = peerName();
  if (!peer || call || incoming) return;
  unlockAudio();
  let stream;
  try {
    stream = await getMedia(video);
  } catch (err) {
    return toast(mediaError(err));
  }
  call = newCall({ peer, video, role: 'caller', stream });
  showCallUI('Calling…');
  sendWs({ type: 'call', video });
  startRing(true);
  call.ringTimer = setTimeout(() => {
    if (call?.state === 'calling') {
      sendWs({ type: 'hangup' });
      endCall(false);
      toast('No answer');
      addSystem(`${video ? 'Video' : 'Audio'} call · no answer`);
    }
  }, RING_TIMEOUT_MS);
}

function newCall(props) {
  return { pc: null, pendingIce: [], state: 'calling', startedAt: 0, tick: null, ringTimer: null, facing: 'user', ...props };
}

function onIncomingCall(msg) {
  // Both pressed "call" at the same moment: the alphabetically smaller name wins.
  if (call?.state === 'calling' && call.role === 'caller' && !call.pc) {
    if (me < msg.from) return;
    stopRing();
    clearTimeout(call.ringTimer);
    call.stream.getTracks().forEach((t) => t.stop());
    call = null;
    el.call.classList.add('hidden');
  }
  if (call || incoming) return sendWs({ type: 'busy' });
  incoming = { from: msg.from, video: !!msg.video };
  el.incomingAvatar.textContent = initial(msg.from);
  el.incomingTitle.textContent = `${msg.from} · ${msg.video ? 'Video' : 'Audio'} call`;
  el.incoming.classList.remove('hidden');
  startRing(false);
  if (document.hidden) document.title = `Incoming call · DuoCall`;
  incoming.timer = setTimeout(() => {
    if (!incoming) return;
    closeIncoming();
    addSystem(`Missed ${msg.video ? 'video' : 'audio'} call from ${msg.from}`);
  }, RING_TIMEOUT_MS);
}

function closeIncoming() {
  stopRing();
  clearTimeout(incoming?.timer);
  incoming = null;
  el.incoming.classList.add('hidden');
  if (!document.hidden) document.title = 'DuoCall';
}

async function acceptCall() {
  if (!incoming) return;
  unlockAudio();
  const { from, video } = incoming;
  closeIncoming();
  let stream;
  try {
    stream = await getMedia(video);
  } catch (err) {
    sendWs({ type: 'decline' });
    return toast(mediaError(err));
  }
  call = newCall({ peer: from, video, role: 'callee', stream, state: 'connecting' });
  showCallUI('Connecting…');
  createPeer();
  sendWs({ type: 'accept' });
}

function declineCall() {
  if (!incoming) return;
  const { from, video } = incoming;
  sendWs({ type: 'decline' });
  closeIncoming();
  addSystem(`Declined ${video ? 'video' : 'audio'} call from ${from}`);
}

function createPeer() {
  const pc = new RTCPeerConnection({ iceServers });
  call.pc = pc;
  call.stream.getTracks().forEach((t) => pc.addTrack(t, call.stream));
  pc.onicecandidate = (e) => e.candidate && sendWs({ type: 'ice', candidate: e.candidate });
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (el.remote.srcObject !== stream) el.remote.srcObject = stream;
    el.remote.play().catch(() => {});
    if (e.track.kind === 'video') el.call.classList.add('has-remote-video');
  };
  pc.onconnectionstatechange = () => {
    if (!call || call.pc !== pc) return;
    const s = pc.connectionState;
    if (s === 'connected') onConnected();
    else if (s === 'disconnected') setCallState('Reconnecting…');
    else if (s === 'failed') {
      sendWs({ type: 'hangup' });
      endCall(true);
      toast('Could not connect the call. Your network may need a TURN server (see README).');
    }
  };
  return pc;
}

async function onAccepted() {
  if (!call || call.role !== 'caller' || call.pc) return;
  stopRing();
  clearTimeout(call.ringTimer);
  call.state = 'connecting';
  setCallState('Connecting…');
  const pc = createPeer();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendWs({ type: 'offer', sdp: pc.localDescription });
}

async function onOffer(msg) {
  if (!call?.pc || call.role !== 'callee') return;
  await call.pc.setRemoteDescription(msg.sdp);
  await flushIce();
  const answer = await call.pc.createAnswer();
  await call.pc.setLocalDescription(answer);
  sendWs({ type: 'answer', sdp: call.pc.localDescription });
}

async function onAnswer(msg) {
  if (!call?.pc || call.role !== 'caller') return;
  await call.pc.setRemoteDescription(msg.sdp);
  await flushIce();
}

async function onIce(msg) {
  if (!call?.pc) return;
  if (call.pc.remoteDescription) {
    try { await call.pc.addIceCandidate(msg.candidate); } catch {}
  } else {
    call.pendingIce.push(msg.candidate);
  }
}

async function flushIce() {
  for (const c of call.pendingIce.splice(0)) {
    try { await call.pc.addIceCandidate(c); } catch {}
  }
}

function onConnected() {
  if (call.state === 'connected') return setCallState(formatDuration());
  call.state = 'connected';
  call.startedAt = Date.now();
  setCallState('00:00');
  call.tick = setInterval(() => setCallState(formatDuration()), 1000);
}

function onRemoteMedia(msg) {
  if (!call) return;
  el.call.classList.toggle('has-remote-video', call.video && !!msg.video);
}

function onRemoteHangup(msg) {
  if (incoming && incoming.from === msg.from) {
    const { video, from } = incoming;
    closeIncoming();
    addSystem(`Missed ${video ? 'video' : 'audio'} call from ${from}`);
    return;
  }
  if (!call) return;
  endCall(true);
  toast(msg.reason === 'left' ? `${msg.from} left` : 'Call ended');
}

function hangup() {
  if (!call) return;
  sendWs({ type: 'hangup' });
  endCall(true);
}

function endCall(logIt) {
  if (!call) return;
  stopRing();
  clearTimeout(call.ringTimer);
  clearInterval(call.tick);
  call.stream?.getTracks().forEach((t) => t.stop());
  call.pc?.close();
  if (logIt) {
    const kind = call.video ? 'Video' : 'Audio';
    addSystem(call.startedAt ? `${kind} call · ${formatDuration()}` : `${kind} call · not connected`);
  }
  call = null;
  el.remote.srcObject = null;
  el.local.srcObject = null;
  el.call.className = 'call hidden';
  el.btnMute.classList.remove('active');
  el.btnCam.classList.remove('active');
  el.local.classList.remove('off', 'back');
}

function showCallUI(state) {
  el.call.className = 'call' + (call.video ? '' : ' audio-only');
  el.callAvatar.textContent = initial(call.peer);
  el.callName.textContent = call.peer;
  setCallState(state);
  if (call.video) {
    el.local.srcObject = call.stream;
    el.local.play().catch(() => {});
    checkCameras();
  }
}

function setCallState(text) {
  el.callState.textContent = text;
}

function formatDuration() {
  const s = Math.floor((Date.now() - call.startedAt) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.slice(-2)}:${ss}` : `${mm}:${ss}`;
}

function toggleMute() {
  const track = call?.stream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  el.btnMute.classList.toggle('active', !track.enabled);
  el.btnMute.setAttribute('aria-label', track.enabled ? 'Mute microphone' : 'Unmute microphone');
}

function toggleCamera() {
  const track = call?.stream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  el.btnCam.classList.toggle('active', !track.enabled);
  el.local.classList.toggle('off', !track.enabled);
  el.btnCam.setAttribute('aria-label', track.enabled ? 'Turn camera off' : 'Turn camera on');
  sendWs({ type: 'media', video: track.enabled });
}

async function checkCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput').length;
    el.btnFlip.classList.toggle('hidden', cams < 2);
  } catch {
    el.btnFlip.classList.add('hidden');
  }
}

async function flipCamera() {
  if (!call?.video) return;
  const facing = call.facing === 'user' ? 'environment' : 'user';
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
    const newTrack = fresh.getVideoTracks()[0];
    const oldTrack = call.stream.getVideoTracks()[0];
    newTrack.enabled = oldTrack ? oldTrack.enabled : true;
    const sender = call.pc?.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
    if (oldTrack) {
      call.stream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    call.stream.addTrack(newTrack);
    call.facing = facing;
    el.local.srcObject = call.stream;
    el.local.classList.toggle('back', facing === 'environment');
  } catch (err) {
    toast(mediaError(err));
  }
}

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

let toastTimer = null;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 4000);
}

// ---------- wiring ----------
el.loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio();
  creds = { name: el.name.value.trim(), password: el.password.value };
  if (!creds.name) return;
  el.loginError.textContent = '';
  manualClose = false;
  connect();
});

el.btnLogout.addEventListener('click', () => {
  hangup();
  if (incoming) declineCall();
  manualClose = true;
  me = null;
  store.del('duocall.creds', sessionStorage);
  ws?.close();
  el.password.value = '';
  showLogin();
});

el.btnAudio.addEventListener('click', () => startCall(false));
el.btnVideo.addEventListener('click', () => startCall(true));
el.btnAccept.addEventListener('click', acceptCall);
el.btnDecline.addEventListener('click', declineCall);
el.btnHangup.addEventListener('click', hangup);
el.btnMute.addEventListener('click', toggleMute);
el.btnCam.addEventListener('click', toggleCamera);
el.btnFlip.addEventListener('click', flipCamera);
window.addEventListener('beforeunload', () => call && sendWs({ type: 'hangup' }));

// Stay signed in across a page refresh (same tab only).
const saved = store.get('duocall.creds', sessionStorage);
if (saved) {
  try {
    creds = JSON.parse(saved);
    connect();
  } catch {
    showLogin();
  }
} else {
  showLogin();
}
