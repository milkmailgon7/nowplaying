// 탭(웹) 버전: 컴퓨터의 도우미 프로그램(helper/spotify_helper.py) 없이 브라우저가 직접 Spotify에 로그인하고 조작한다.
// script.js는 도우미에게 묻던 것(/api/...)을 window.webHelper 에 묻는다. 주고받는 모양은 도우미와 같다.
// 로그인 정보(리프레시 토큰)는 이 브라우저의 localStorage에만 둔다.
(() => {
  'use strict';

  const CLIENT_ID = window.SPOTIFY_CLIENT_ID; // config.js (build.py가 만듦)
  const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing '
    + 'playlist-read-private playlist-read-collaborative user-library-read user-library-modify';
  const API = 'https://api.spotify.com/v1';
  const ACCOUNTS = 'https://accounts.spotify.com';
  const LRCLIB = 'https://lrclib.net/api';
  // 주소에 /가 겹쳐도(…/nowplaying//) 등록한 주소와 같아지게 주소창부터 정리한다
  if (/\/{2,}/.test(location.pathname)) {
    history.replaceState(null, '', location.pathname.replace(/\/{2,}/g, '/') + location.search + location.hash);
  }
  // Spotify 개발자 화면의 Redirect URIs에 이 주소(페이지 주소)를 똑같이 넣어 둬야 한다
  const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
  const AUTH_KEY = 'np-auth';   // { refresh_token, scope }
  const PKCE_KEY = 'np-pkce';   // 로그인 중: { verifier, state }
  // 안드로이드 앱(android 폴더)에서 열리면 주소 끝에 ?app(앱 화면) 또는 ?wallpaper(바탕화면)가 붙는다.
  // 두 화면은 같은 localStorage를 쓰므로 앱 화면에서 로그인하면 바탕화면도 로그인된다.
  const params = new URLSearchParams(location.search);
  const MODE = params.has('wallpaper') ? 'wallpaper' : params.has('app') ? 'app' : 'web';
  document.documentElement.dataset.mode = MODE; // tablet.css가 바탕화면 모양을 고름
  const APP_PACKAGE = 'app.nowplaying.wallpaper';

  class NotLoggedIn extends Error {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 로그인 (Authorization Code + PKCE) ----------

  let auth = load(AUTH_KEY) || {};
  let accessToken = null;
  let expiresAt = 0;
  let refreshing = null; // 토큰을 새로 받는 중이면 그 Promise (여러 요청이 한 번만 받게)
  let loginError = '';
  let handoff = null;    // 앱에서 시작한 로그인을 브라우저에서 마쳤을 때 앱으로 돌아갈 주소

  function load(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (e) {
      return null;
    }
  }

  function store(key, value) {
    try {
      if (value) localStorage.setItem(key, JSON.stringify(value));
      else localStorage.removeItem(key);
    } catch (e) {
      // 저장이 막힌 브라우저면 이번만 쓰고 끝
    }
  }

  function randomString(n) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return base64url(bytes).slice(0, n);
  }

  function base64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function login() {
    const verifier = randomString(64);
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    // 앱 화면은 Spotify 로그인을 브라우저로 넘기므로, 돌아올 곳이 앱이라는 표시를 state에 붙인다
    const state = (MODE === 'app' ? 'app-' : '') + randomString(16);
    // sessionStorage가 아니라 localStorage: 홈 화면 앱에서 로그인하면 돌아올 때 다른 창일 수 있음
    store(PKCE_KEY, { verifier, state });
    location.href = `${ACCOUNTS}/authorize?${new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
      state,
    })}`;
  }

  function logout() {
    auth = {};
    accessToken = null;
    store(AUTH_KEY, null);
  }

  // ---------- 작은 알림 ----------
  // 오류 안내는 원래 목록 칸(#panel) 안에 뜨는데, 휴대폰과 세로 바탕화면에는 목록 칸이 없어서 안 보인다.
  // 그럴 때는 앨범 아트 아래쪽에 작은 알림으로 대신 보여 준다. 인터넷이 끊겼을 때도 여기에 알린다.

  const toast = document.createElement('div');
  toast.id = 'web-toast';
  let panelText = '';   // 목록 칸이 안 보일 때 대신 보여 줄 안내
  let netDown = false;  // Spotify에 한동안 연결하지 못함

  function drawToast() {
    const text = netDown ? '인터넷 연결이 끊겼어요' : panelText;
    const on = !!text && !document.querySelector('#web-login.on'); // 로그인 화면이 떠 있으면 그쪽이 알려 줌
    if (on) {
      if (!toast.isConnected) document.body.append(toast);
      toast.textContent = text;
      const art = document.getElementById('art').getBoundingClientRect();
      toast.style.left = `${art.left + art.width / 2}px`;
      toast.style.top = `${art.bottom}px`; // tablet.css가 제 높이만큼 위로 올려서 아트 아래쪽 안에 놓음
      toast.style.maxWidth = `${art.width * 0.9}px`;
    }
    toast.classList.toggle('on', on);
  }

  {
    const msg = document.getElementById('panel-msg');
    const panel = document.getElementById('panel');
    const sync = () => {
      const shown = msg.classList.contains('on') && getComputedStyle(panel).display === 'none';
      panelText = shown ? msg.textContent : '';
      drawToast();
    };
    new MutationObserver(sync).observe(msg, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
    window.addEventListener('resize', sync); // 화면을 돌리면 목록 칸이 생기거나 없어짐
  }

  // ---------- 인터넷 요청 ----------
  // 응답이 안 오는 요청은 10초에 끊는다 (2초마다 묻는데 안 끊으면 계속 쌓임).
  // 6초 넘게 연달아 실패하면 인터넷이 끊겼다고 알리고, 한 번이라도 되면 지운다.
  // (화면을 막 켰을 때 와이파이가 다시 붙는 1~2초 동안은 알리지 않으려고 6초를 기다림)

  const TIMEOUT_MS = 10000;
  let failingSince = 0;

  // since: 실패한 요청을 보낸 때 (응답 없이 10초를 기다린 것이면 그때부터 센다)
  let lastOk = 0;

  function netResult(ok, since) {
    if (ok) {
      failingSince = 0;
      lastOk = Date.now();
    } else if (since < lastOk) {
      return; // 그 뒤에 보낸 요청이 이미 성공했음 (오래 걸리다 끊긴 옛 요청)
    } else if (!failingSince) {
      failingSince = since;
    }
    const down = !ok && Date.now() - failingSince >= 6000;
    if (down !== netDown) {
      netDown = down;
      drawToast();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) netResult(true); // 화면을 다시 켰으면 처음부터 다시 셈
  });

  // 응답의 { status, text, retryAfter(초) }. 연결하지 못했으면 오류를 던진다
  async function request(url, init) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
    const sent = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: stop.signal });
      const text = await res.text();
      netResult(true);
      return { status: res.status, text, retryAfter: Number(res.headers.get('Retry-After')) || 0 };
    } catch (e) {
      netResult(false, sent);
      throw new Error('인터넷에 연결할 수 없어요');
    } finally {
      clearTimeout(timer);
    }
  }

  const parse = (text) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch (e) {
      return null; // 재생 조작은 성공해도 JSON이 아닌 응답이 올 때가 있음
    }
  };

  async function tokenRequest(form) {
    const res = await request(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    const data = parse(res.text) || {};
    if (res.status >= 300) {
      if (res.status === 400 || res.status === 401) {
        // 앱 화면과 바탕화면이 같은 토큰을 쓰다가 다른 쪽이 먼저 새 토큰으로 바꿨으면, 로그아웃하지 않고 그걸 쓴다
        const stored = load(AUTH_KEY);
        if (form.grant_type === 'refresh_token' && stored && stored.refresh_token && stored.refresh_token !== form.refresh_token) {
          auth = stored;
          throw new Error('잠시 후 다시 해 주세요');
        }
        // 리프레시 토큰이 취소/만료됨 → 다시 로그인해야 함
        logout();
        throw new NotLoggedIn();
      }
      throw new Error(`Spotify 로그인 오류 (${res.status})`);
    }
    accessToken = data.access_token;
    expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    auth = {
      refresh_token: data.refresh_token || auth.refresh_token,
      scope: data.scope != null ? data.scope : auth.scope,
    };
    store(AUTH_KEY, auth);
  }

  // Spotify가 로그인 화면에서 돌려보낸 주소(?code=...)면 토큰으로 바꾼다
  async function finishLogin() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return;
    history.replaceState(null, '', REDIRECT_URI); // 주소창에서 code를 지움
    const pending = load(PKCE_KEY);
    store(PKCE_KEY, null);
    if (q.has('error')) {
      loginError = q.get('error') === 'access_denied' ? '로그인을 취소했어요' : `로그인하지 못했어요 (${q.get('error')})`;
      return;
    }
    if (!pending || pending.state !== q.get('state')) {
      if ((q.get('state') || '').startsWith('app-')) {
        // 앱 화면에서 시작한 로그인: code를 여기서 쓰지 않고 앱으로 넘긴다 (확인용 값이 앱 쪽에 있음)
        handoff = `intent://login?${new URLSearchParams({ code: q.get('code'), state: q.get('state') })}`
          + `#Intent;scheme=nowplaying;package=${APP_PACKAGE};end`;
        return;
      }
      loginError = '로그인 요청이 만료됐어요. 다시 눌러 주세요.';
      return;
    }
    try {
      await tokenRequest({
        grant_type: 'authorization_code',
        code: q.get('code'),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: pending.verifier,
      });
    } catch (e) {
      loginError = e instanceof NotLoggedIn ? '로그인하지 못했어요. 다시 눌러 주세요.' : e.message;
    }
  }

  function token() {
    if (accessToken && Date.now() < expiresAt - 60000) return Promise.resolve(accessToken);
    const stored = load(AUTH_KEY); // 다른 화면(앱/바탕화면)이 로그인했거나 토큰을 바꿨을 수 있음
    if (stored && stored.refresh_token) auth = stored;
    if (!auth.refresh_token) return Promise.reject(new NotLoggedIn());
    if (!refreshing) {
      refreshing = tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: auth.refresh_token,
        client_id: CLIENT_ID,
      }).then(() => accessToken).finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  function hasScope(scope) {
    return auth.scope == null || auth.scope.split(' ').includes(scope);
  }

  // ---------- Web API ----------

  // Spotify가 "요청이 너무 많다"(429)고 하면 쉬라는 시간 동안은 아예 묻지 않는다.
  // 계속 물으면 막히는 시간이 더 길어진다. 쉬라는 시간을 못 읽으면 5초, 10초, 20초… 최대 5분씩 늘려 쉰다
  let blockedUntil = 0;
  let blockCount = 0;

  async function api(method, path, params, body, retry = true) {
    if (Date.now() < blockedUntil) return [429, null];
    const url = API + path + (params ? `?${new URLSearchParams(params)}` : '');
    const headers = { Authorization: `Bearer ${await token()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (res.status === 401 && retry) {
      accessToken = null;
      return api(method, path, params, body, false);
    }
    if (res.status === 429) {
      blockCount++;
      const wait = res.retryAfter || Math.min(300, 5 * 2 ** (blockCount - 1));
      blockedUntil = Date.now() + Math.min(wait, 3600) * 1000;
      console.info('[NowPlaying] Spotify 429, waiting', wait, 's');
    } else {
      blockCount = 0;
    }
    return [res.status, parse(res.text)];
  }

  function errorMessage(code, payload) {
    const err = payload && typeof payload === 'object' ? payload.error : null;
    const reason = err && typeof err === 'object' ? err.reason || err.message || '' : '';
    if (code === 401) return 'Spotify 로그인이 필요해요';
    if (code === 403) return reason.toUpperCase().includes('PREMIUM') ? 'Spotify Premium이 필요한 기능이에요' : 'Spotify가 요청을 거절했어요';
    if (code === 404) return '재생할 기기를 찾지 못했어요. Spotify 앱을 켜 주세요';
    if (code === 429) return '요청이 너무 많아요. 잠시 후 다시 해 주세요';
    return `Spotify 오류 (${code})`;
  }

  // api()의 [code, data] (또는 그 Promise): 실패면 오류를 던지고, 성공이면 받은 내용을 돌려준다
  async function ok(result) {
    const [code, data] = await result;
    if (code >= 300) throw new Error(errorMessage(code, data));
    return data;
  }

  // 재생 조작. 활성 기기가 없으면(404) 기기를 골라 다시 시도한다.
  async function player(method, path, body, params) {
    const [code, data] = await api(method, path, params, body);
    if (code !== 404) return [code, data];
    const [, list] = await api('GET', '/me/player/devices');
    const devices = (list && list.devices) || [];
    if (!devices.length) return [code, data];
    const device = devices.find((d) => d.is_active)
      || devices.find((d) => d.type === 'Tablet' || d.type === 'Smartphone')
      || devices.find((d) => d.type === 'Computer') || devices[0];
    return api(method, path, { ...params, device_id: device.id }, body);
  }

  // 패널에 쓸 작은 이미지: 가로 100px 이상 중 가장 작은 것
  function pickImage(images) {
    const sorted = (images || []).filter((i) => i && i.url).sort((a, b) => (a.width || 0) - (b.width || 0));
    const small = sorted.find((i) => (i.width || 0) >= 100);
    return small ? small.url : sorted.length ? sorted[sorted.length - 1].url : null;
  }

  function simpleTrack(t) {
    if (!t) return null;
    const album = t.album || {};
    const images = album.images || t.images || [];
    const artists = (t.artists || []).map((a) => a.name || '').join(', ');
    const largest = images.reduce((a, b) => ((b.width || 0) > ((a && a.width) || 0) ? b : a), null);
    return {
      name: t.name,
      artists: artists || (t.show && t.show.name) || '',
      album: album.name,
      image: pickImage(images),            // 패널용 작은 그림
      art: largest ? largest.url : null,   // 가운데용 큰 그림 (보통 640px)
      uri: t.uri,
      album_uri: album.uri,
      duration_ms: t.duration_ms || 0,
    };
  }

  // ---------- 도우미와 같은 /api/... ----------

  let userId = null; // '좋아요 표시한 곡' 재생 주소에 씀

  let playerAsked = 0;    // /me/player를 물은 차례
  let playerAnswered = 0; // 화면에 반영한 마지막 차례

  // ---------- 이 기기에서 재생 중일 때의 볼륨 ----------
  // Spotify가 바로 이 휴대폰·탭의 Spotify 앱에서 재생 중이면 Spotify 서버가 볼륨 원격 조절을 막는다
  // (supports_volume=false, 바꾸려 하면 403). 그때는 안드로이드 앱(Site.Bridge)을 통해 기기 미디어 볼륨을 직접 쓴다.
  // Spotify 앱은 기기 미디어 볼륨을 그대로 따른다.
  let localVolume = false; // 지금 재생 기기가 이 기기라서 볼륨을 직접 조절하는지

  function localAudio() {
    const app = window.NowPlayingApp;
    if (!app || !app.localAudio || !app.setLocalVolume) return null; // 옛 앱이거나 브라우저
    try {
      return JSON.parse(app.localAudio());
    } catch (e) {
      return null;
    }
  }

  // Spotify가 알려 준 재생 기기가 이 기기인지: 이름이 같거나(Spotify 앱은 기기 이름을 씀),
  // 이름이 달라도 이 기기에서 음악이 나오고 있고 종류(탭/휴대폰)가 같으며 원격 볼륨이 막혀 있으면
  function isThisDevice(device, local) {
    if (!local || !device) return false;
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
    const name = norm(device.name);
    if (name && (name === norm(local.name) || name === norm(local.model))) return true;
    return !!local.active && device.supports_volume === false
      && device.type === (local.tablet ? 'Tablet' : 'Smartphone');
  }

  async function apiPlayer() {
    const turn = ++playerAsked;
    const [code, p] = await api('GET', '/me/player');
    // 느린 연결에서 먼저 물은 것의 답이 나중에 오면 버린다 (옛 곡·옛 위치로 되돌아가지 않게)
    if (turn < playerAnswered) throw new Error('늦게 온 응답');
    playerAnswered = turn;
    if (code === 204 || (!p && code < 300)) {
      setPlaying(false);
      return { active: false };
    }
    if (code >= 300) throw new Error(errorMessage(code, p));
    setPlaying(!!p.is_playing);
    const device = p.device || {};
    const local = localAudio();
    const wasLocal = localVolume;
    localVolume = isThisDevice(device, local);
    if (localVolume !== wasLocal) console.info('[NowPlaying] volume via', localVolume ? 'this device' : 'Spotify', device.type, device.supports_volume);
    if (localVolume) {
      device.volume_percent = local.percent;
      device.supports_volume = true;
    }
    return {
      active: true,
      is_playing: !!p.is_playing,
      track: simpleTrack(p.item),
      context_uri: (p.context || {}).uri,
      repeat: p.repeat_state || 'off',
      shuffle: !!p.shuffle_state,
      progress_ms: p.progress_ms || 0,
      duration_ms: (p.item || {}).duration_ms || 0,
      volume: device.volume_percent,
      supports_volume: device.supports_volume !== false,
    };
  }

  async function apiQueue() {
    const q = (await ok(api('GET', '/me/player/queue'))) || {};
    return { current: simpleTrack(q.currently_playing), queue: (q.queue || []).filter(Boolean).map(simpleTrack) };
  }

  // '좋아요 표시한 곡'은 /me/playlists에 없어서 따로 만든다
  async function likedSongs() {
    if (!userId) {
      const [code, me] = await api('GET', '/me');
      if (code >= 300 || !me || !me.id) return null;
      userId = me.id;
    }
    let total = null;
    if (hasScope('user-library-read')) {
      const [code, page] = await api('GET', '/me/tracks', { limit: 1 });
      if (code < 300 && page) total = page.total;
    }
    return { name: '좋아요 표시한 곡', owner: null, image: null, uri: `spotify:user:${userId}:collection`, total, liked: true };
  }

  async function apiPlaylists() {
    const liked = await likedSongs();
    const out = liked ? [liked] : [];
    for (let offset = 0; offset < 200; offset += 50) {
      const page = (await ok(api('GET', '/me/playlists', { limit: 50, offset }))) || {};
      for (const p of page.items || []) {
        if (!p) continue;
        const count = p.items || p.tracks || {};
        out.push({
          name: p.name,
          owner: (p.owner || {}).display_name,
          image: pickImage(p.images),
          uri: p.uri,
          total: count.total,
        });
      }
      if (offset + 50 >= (page.total || 0)) break;
    }
    return out;
  }

  async function apiControl(body) {
    const action = body.action;
    if (action === 'repeat') return ok(player('PUT', '/me/player/repeat', undefined, { state: body.state }));
    if (action === 'shuffle') return ok(player('PUT', '/me/player/shuffle', undefined, { state: body.state ? 'true' : 'false' }));
    if (action === 'volume') {
      const volume = Math.min(100, Math.max(0, Math.round(Number(body.volume_percent) || 0)));
      if (localVolume && localAudio()) {
        window.NowPlayingApp.setLocalVolume(volume); // 이 기기에서 재생 중: 기기 미디어 볼륨을 직접
        return {};
      }
      return ok(player('PUT', '/me/player/volume', undefined, { volume_percent: volume }));
    }
    if (action === 'queue') return ok(player('POST', '/me/player/queue', undefined, { uri: body.uri }));
    if (action === 'seek') return ok(player('PUT', '/me/player/seek', undefined, { position_ms: Math.max(0, Math.round(body.position_ms)) }));
    const routes = {
      next: ['POST', '/me/player/next'],
      previous: ['POST', '/me/player/previous'],
      play: ['PUT', '/me/player/play'],
      pause: ['PUT', '/me/player/pause'],
    };
    if (!routes[action]) throw new Error('알 수 없는 동작');
    return ok(player(...routes[action]));
  }

  // 플레이리스트 재생, 또는 대기열의 곡으로 건너뛰기.
  // context_uri + offset_uri 로 바로 재생해 보고, 안 되면(대기열에 직접 넣은 곡 등) skip 횟수만큼 다음 곡으로 넘긴다.
  async function apiPlay(body) {
    const skip = Number(body.skip) || 0;
    let res = [400, null];
    if (body.context_uri) {
      const payload = { context_uri: body.context_uri };
      if (body.offset_uri) payload.offset = { uri: body.offset_uri };
      res = await player('PUT', '/me/player/play', payload);
      if (res[0] < 300 || !skip) return ok(res);
    }
    for (let i = 0; i < Math.min(skip, 50); i++) {
      res = await player('POST', '/me/player/next');
      if (res[0] >= 300) break;
      await sleep(150);
    }
    return ok(res);
  }

  async function apiSearch(q) {
    const query = (q.get('q') || '').trim();
    if (!query) return [];
    // 개발자 모드 앱은 한 번에 최대 10개
    const data = await ok(api('GET', '/search', { q: query, type: 'track', limit: 10 }));
    return (((data || {}).tracks || {}).items || []).filter(Boolean).map(simpleTrack);
  }

  const trackUris = (raw) => (raw || '').split(',').filter((u) => /^spotify:track:[0-9A-Za-z]+$/.test(u)).slice(0, 40);

  async function apiLiked(q) {
    const uris = trackUris(q.get('uris'));
    await token();
    if (!hasScope('user-library-read')) return { need_login: true, liked: {} };
    if (!uris.length) return { liked: {} };
    const data = await ok(api('GET', '/me/library/contains', { uris: uris.join(',') }));
    return { liked: Object.fromEntries(uris.map((u, i) => [u, !!(data || [])[i]])) };
  }

  async function apiLike(body) {
    const uris = trackUris(body.uri);
    if (!uris.length) throw new Error('알 수 없는 곡');
    return ok(api(body.on ? 'PUT' : 'DELETE', '/me/library', { uris: uris[0] }));
  }

  // ---------- 가사 (LRCLIB) ----------
  // 도우미의 find_lyrics와 같은 방법: /get으로 찾고, 없으면 검색해서 제목이 맞고 길이가 3초 안쪽인 것.

  class LyricsUnavailable extends Error {}

  async function lrclib(path, params) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = attempt === 2;
      try {
        const res = await fetch(`${LRCLIB}${path}?${new URLSearchParams(params)}`);
        if (res.status === 404) return null;
        if (res.ok) return await res.json();
        if (res.status < 500 || last) throw new LyricsUnavailable(`${path} ${res.status}`);
      } catch (e) {
        if (e instanceof LyricsUnavailable || last) throw new LyricsUnavailable(`${path} ${e.message}`);
      }
      await sleep(600 * (attempt + 1)); // 가끔 503이 나서 조금 쉬고 다시
    }
    return null;
  }

  // '[01:02.50]가사' 줄들을 [[ms, 가사], ...] 로. 한 줄에 시간이 여러 개 붙은 것도 처리.
  function parseLrc(text) {
    const out = [];
    for (const raw of (text || '').split(/\r?\n/)) {
      let rest = raw.trim();
      const stamps = [];
      for (let m; (m = /^\[(\d+):(\d+)(?:[.:](\d+))?\]/.exec(rest));) {
        const frac = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0;
        stamps.push((Number(m[1]) * 60 + Number(m[2])) * 1000 + frac);
        rest = rest.slice(m[0].length);
      }
      for (const ms of stamps) out.push([ms, rest.trim()]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out.length ? out : null;
  }

  const simplify = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); // 글자·숫자만
  // '서쪽 하늘에 - 2025 New Ver.' → '서쪽 하늘에',  'Song (feat. X)' → 'Song'
  const cleanTitle = (t) => t.replace(/\s+-\s+.*$/, '').replace(/\s*[([].*?[)\]]/g, '').trim() || t;

  async function findLyrics(track, artists, album, duration) {
    const artist = artists.split(', ')[0];
    let failed = null;
    try {
      const params = Object.fromEntries(Object.entries({
        track_name: track, artist_name: artist, album_name: album, duration: Math.round(duration) || '',
      }).filter(([, v]) => v));
      const data = await lrclib('/get', params);
      if (data && data.syncedLyrics) return data.syncedLyrics;
    } catch (e) {
      // /get은 모음에 없는 곡이면 503을 줄 때가 있어서, 아래 검색 결과로 판단한다
    }
    const want = simplify(cleanTitle(track));
    for (const q of new Set([`${cleanTitle(track)} ${artist}`, cleanTitle(track)])) {
      let items;
      try {
        items = (await lrclib('/search', { q })) || [];
      } catch (e) {
        failed = e;
        continue;
      }
      let best = null;
      for (const item of items) {
        const name = simplify(item.trackName);
        if (!item.syncedLyrics || !want || !(name.includes(want) || want.includes(name))) continue;
        const diff = duration ? Math.abs((item.duration || 0) - duration) : 0;
        if (diff <= 3 && (!best || diff < best[0])) best = [diff, item.syncedLyrics];
      }
      if (best) return best[1];
      await sleep(200); // LRCLIB는 요청 사이를 조금 띄워 달라고 함
    }
    if (failed) throw failed;
    return null;
  }

  async function apiLyrics(q) {
    const track = (q.get('track') || '').trim();
    if (!track) return { lines: null };
    try {
      const text = await findLyrics(track, (q.get('artist') || '').trim(), (q.get('album') || '').trim(), (Number(q.get('duration')) || 0) / 1000);
      return { lines: parseLrc(text) };
    } catch (e) {
      throw new Error('가사 사이트에 연결하지 못했어요'); // script.js가 20초 뒤 다시 시도
    }
  }

  // ---------- 검색 입력칸 ----------
  // 도우미는 배경화면 위에 입력칸을 겹쳐 띄웠지만, 탭에서는 진짜 입력칸을 같은 자리(화면 비율)에 띄운다.

  function promptSearch(q) {
    const f = (k) => Number(q.get(k)) * 100;
    const input = document.createElement('input');
    input.id = 'web-search';
    input.type = 'search';
    input.enterKeyHint = 'search';
    input.autocomplete = 'off';
    Object.assign(input.style, {
      left: `${f('x0')}vw`,
      top: `${f('y0')}vh`,
      width: `${f('x1') - f('x0')}vw`,
      height: `${f('y1') - f('y0')}vh`,
    });
    document.body.append(input);
    input.focus(); // 누른 직후라서 화면 키보드가 뜬다
    return new Promise((resolve) => {
      let done = false;
      const finish = (query) => {
        if (done) return;
        done = true;
        input.remove();
        resolve({ query });
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) finish(input.value.trim() || null);
        else if (e.key === 'Escape') finish(null);
      });
      input.addEventListener('blur', () => finish(null)); // 키보드를 내리거나 다른 곳을 누르면 닫힘
    });
  }

  // ---------- 화면 켜 두기 ----------
  // 노래가 나오는 동안은 탭 화면이 꺼지지 않게 한다 (멈추면 원래 설정대로 꺼짐)

  let playing = false;
  let wakeLock = null;

  function setPlaying(on) {
    // 안드로이드 앱은 노래가 나오는 동안 잠금화면 위에서 화면을 켜 둔다 (android 폴더의 Site.Bridge)
    if (on !== playing && window.NowPlayingApp) window.NowPlayingApp.setPlaying(on);
    playing = on;
    syncWakeLock();
  }

  async function syncWakeLock() {
    if (!('wakeLock' in navigator) || MODE === 'wallpaper') return; // 바탕화면이 화면을 켜 두면 안 됨
    if (playing && !wakeLock && !document.hidden) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      } catch (e) {
        wakeLock = null; // 배터리 절약 모드 등으로 막히면 그냥 둔다
      }
    } else if (!playing && wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  document.addEventListener('visibilitychange', syncWakeLock); // 화면을 다시 켜면 다시 잡음

  // ---------- 잠금화면 터치 ----------
  // 잠금화면은 바탕화면에 터치를 넘겨 주지 않는다. 그래서 앱의 접근성 기능(android 폴더의 LockTouchService)이
  // 버튼이 있는 자리만 투명하게 덮어 터치를 받고 이 페이지에 넘긴다. 그 자리를 화면 픽셀로 알려 준다
  if (MODE === 'wallpaper' && window.NowPlayingApp && window.NowPlayingApp.setTouchAreas) {
    const AREAS = ['#controls', '#btn-like', '#volume', '#panel'];
    const PAD = 6; // 손가락이 조금 빗나가도 되게 (CSS px)
    let sent = '';
    const report = () => {
      const k = window.devicePixelRatio || 1;
      const rects = [];
      for (const sel of AREAS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        rects.push([r.left - PAD, r.top - PAD, r.right + PAD, r.bottom + PAD].map((v) => Math.round(v * k)));
      }
      const json = JSON.stringify(rects);
      if (json === sent) return;
      sent = json;
      window.NowPlayingApp.setTouchAreas(json);
    };
    const watch = new ResizeObserver(report);
    const start = () => {
      for (const sel of AREAS) {
        const el = document.querySelector(sel);
        if (el) watch.observe(el);
      }
      report();
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
    window.addEventListener('resize', report);
    setInterval(report, 2000); // 자리만 옮겨지거나 숨겨진 것도 잡게 (바탕화면이 안 보이면 멈춤)
  }

  // ---------- 로그인 화면 ----------

  const gate = document.createElement('div');
  gate.id = 'web-login';
  gate.innerHTML = `
    <div class="card">
      <div class="title">Spotify에 로그인해 주세요</div>
      <div class="desc">듣고 있는 노래를 보여 주고 조작하려면 처음 한 번 로그인이 필요해요.</div>
      <button type="button">Spotify로 로그인</button>
      <div class="error"></div>
    </div>`;
  gate.querySelector('button').addEventListener('click', () => {
    if (handoff) {
      location.href = handoff;
      return;
    }
    if (!CLIENT_ID) {
      gate.querySelector('.error').textContent = 'config.js에 Spotify Client ID가 없어요. 컴퓨터에서 tablet/build.py를 다시 실행해 주세요.';
      return;
    }
    login();
  });

  // 바탕화면에서는 글자를 칠 수 없어서 앱 화면에서 로그인하라고만 알려 준다 (버튼은 tablet.css가 숨김)
  if (MODE === 'wallpaper') {
    gate.querySelector('.desc').textContent = 'Now Playing 앱을 열어 Spotify에 로그인해 주세요. 로그인하면 바탕화면에도 바로 나와요.';
  }

  function showGate(on) {
    if (on && !gate.isConnected) document.body.append(gate);
    gate.classList.toggle('on', on);
    gate.querySelector('.error').textContent = loginError;
  }

  // 앱 화면에서 시작한 로그인을 브라우저에서 마쳤으면 앱으로 돌아가는 버튼을 보여 준다
  function showHandoff() {
    gate.querySelector('.title').textContent = '로그인했어요';
    gate.querySelector('.desc').textContent = '아래 버튼을 눌러 Now Playing 앱으로 돌아가 주세요.';
    gate.querySelector('button').textContent = '앱으로 돌아가기';
    showGate(true);
    location.href = handoff; // 브라우저가 막으면 버튼으로
  }

  // 세로로 들면 화면이 맞지 않아서 돌려 달라고 한다 (tablet.css가 세로일 때만 보이게 함)
  const rotate = document.createElement('div');
  rotate.id = 'web-rotate';
  rotate.textContent = '탭을 가로로 돌려 주세요';
  document.body.append(rotate);

  // ---------- script.js가 부르는 곳 ----------

  // 첫 요청 전에 로그인 돌아온 것부터 처리
  const ready = finishLogin().then(() => {
    if (handoff) showHandoff();
  });

  window.webHelper = (path, body) => {
    const [route, query] = path.split('?');
    const q = new URLSearchParams(query || '');
    // 검색칸은 누른 순간에 입력칸을 띄워야 화면 키보드가 뜬다 (기다리지 않고 바로)
    if (route === '/api/search/prompt') return promptSearch(q);
    return ready.then(() => dispatch(route, q, body)).catch((e) => {
      if (e instanceof NotLoggedIn) {
        showGate(true);
        throw new Error('Spotify 로그인이 필요해요');
      }
      throw e;
    });
  };

  async function dispatch(route, q, body) {
    // 재생을 바꾸는 요청은 기록을 남긴다 (안드로이드 앱에서는 탭의 logcat에 'chromium' 줄로 보임).
    // 노래가 혼자 멈췄을 때 이 화면이 멈춘 건지 가리려고
    if (route === '/api/control' || route === '/api/play') console.info('[NowPlaying]', MODE, route, JSON.stringify(body));
    switch (route) {
      case '/api/status':
        if (!auth.refresh_token) auth = load(AUTH_KEY) || {}; // 바탕화면이면 앱 화면에서 방금 로그인했을 수 있음
        showGate(!auth.refresh_token);
        return auth.refresh_token
          ? { ready: true, step: 'ok' }
          : { ready: false, msg: MODE === 'wallpaper'
            ? 'Spotify 로그인이 필요해요.\nNow Playing 앱을 열어 로그인해 주세요.'
            : 'Spotify 로그인이 필요해요.\n화면 가운데의 로그인 버튼을 눌러 주세요.' };
      case '/api/player': return apiPlayer();
      case '/api/queue': return apiQueue();
      case '/api/playlists': return apiPlaylists();
      case '/api/control': return apiControl(body);
      case '/api/play': return apiPlay(body);
      case '/api/search': return apiSearch(q);
      case '/api/liked': return apiLiked(q);
      case '/api/like': return apiLike(body);
      case '/api/lyrics': return apiLyrics(q);
      default: throw new Error('알 수 없는 요청');
    }
  }

  // 새 버전 저절로 받기: 앱 화면·바탕화면은 페이지를 한 번 열면 계속 띄워 두어서, GitHub에 새 파일을 올려도
  // 다시 열기 전까지 옛 화면 그대로다. 그래서 화면이 보이는 동안 5분에 한 번 index.html을 새로 받아 보고
  // 파일 버전(?v=)이 바뀌었으면 페이지를 다시 불러온다
  if (MODE !== 'web') {
    const versions = (list) => list.filter((u) => u.includes('?v=')).sort().join(' ');
    let checkedAt = Date.now();
    const checkUpdate = async () => {
      if (document.hidden || Date.now() - checkedAt < 5 * 60 * 1000) return;
      checkedAt = Date.now();
      try {
        const res = await fetch(location.pathname, { cache: 'no-cache' });
        if (!res.ok) return;
        const html = await res.text();
        const latest = versions([...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]));
        const current = versions([...document.querySelectorAll('[href], [src]')].map((e) => e.getAttribute('href') || e.getAttribute('src')));
        if (latest && latest !== current) location.reload();
      } catch (e) {
        // 인터넷이 잠깐 안 되면 다음에 다시
      }
    };
    document.addEventListener('visibilitychange', checkUpdate);
    setInterval(checkUpdate, 60 * 1000);
  }

  // 홈 화면에 추가하면 전체 화면 앱처럼 열리게 (sw.js가 있어야 설치할 수 있음)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
