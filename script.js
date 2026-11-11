(() => {
  'use strict';

  const FADE_MS = 800;       // 앨범 아트·배경 색 크로스페이드. style.css의 --fade와 맞춤
  const LOOK_FADE_MS = 1600; // 흐린 배경·아트 뒤 빛. style.css의 --look-fade와 맞춤
  const HI_Q = 1000;    // 그림 품질 값: Windows 썸네일 300, Spotify 640, 고해상도(iTunes) 1000

  const bgLayers = document.querySelectorAll('.bg-layer');
  const artBox = document.getElementById('art');
  const artLayers = document.querySelectorAll('.art-layer');
  const info = document.getElementById('info');
  const titleEl = document.getElementById('title');
  const subEl = document.getElementById('sub');

  const bgState = { idx: 0, gen: 0 };
  const artState = { idx: 0, gen: 0 };

  // 앨범 아트를 크게 흐려 배경에 깐 것(.ambient-layer)과 아트 뒤 아트 색 빛(.glow-layer). 모양은 style.css.
  // 탭 버전의 앱 화면(로그인·검색용, data-mode="app")에는 넣지 않는다
  const lookLayers = [];
  const lookState = { idx: 0, gen: 0 };
  if (document.documentElement.dataset.mode !== 'app') {
    const make = (cls) => [0, 1].map(() => Object.assign(document.createElement('div'), { className: cls }));
    const ambient = make('ambient-layer');
    const glow = make('glow-layer');
    const shade = Object.assign(document.createElement('div'), { id: 'ambient-shade' });
    const grain = Object.assign(document.createElement('div'), { id: 'ambient-grain' });
    document.getElementById('bg').after(...ambient, shade, grain, ...glow);
    lookLayers.push(ambient, glow);
  }

  // 흐린 배경과 빛을 새 그림으로. 새 장을 옛 장 위에 올려 천천히 나타나게 하고(LOOK_FADE_MS), 다 나타나면 옛 장을 치운다.
  // (둘을 동시에 흐려지고 나타나게 하면 중간에 화면이 한 번 어두워짐) null이면 둘 다 천천히 사라짐
  function setLookArt(src) {
    if (!lookLayers.length) return;
    const gen = ++lookState.gen;
    if (!src) {
      for (const pair of lookLayers) for (const el of pair) el.classList.remove('on');
      return;
    }
    const pic = new Image();
    pic.src = src;
    (pic.decode ? pic.decode() : Promise.resolve()).catch(() => {}).then(() => {
      if (lookState.gen !== gen) return;
      lookState.idx ^= 1;
      for (const pair of lookLayers) {
        const next = pair[lookState.idx];
        const prev = pair[lookState.idx ^ 1];
        prev.after(next); // 같은 자리의 두 장 중 새 장을 위로 (z-index를 쓰면 앨범 아트·글자보다 위로 올라감)
        next.style.backgroundImage = `url("${src.replace(/"/g, '%22')}")`;
        next.style.transition = 'none';
        next.classList.remove('on');
        void next.offsetWidth;
        next.style.transition = '';
        next.classList.add('on');
      }
      setTimeout(() => {
        if (lookState.gen !== gen) return;
        for (const pair of lookLayers) {
          const prev = pair[lookState.idx ^ 1];
          prev.style.transition = 'none'; // 새 장에 다 가려졌으니 바로 치움
          prev.classList.remove('on');
          prev.style.backgroundImage = '';
          void prev.offsetWidth;
          prev.style.transition = '';
        }
      }, LOOK_FADE_MS + 100);
    });
  }

  let hostSeen = false;  // Lively / Wallpaper Engine에서 신호가 온 적 있는지
  let shownKey = null;   // 화면에 보이는 곡 (제목으로 구분)
  let nowTrack = null;   // 화면에 보이는 곡 정보
  let shownSpotify = false; // 보이는 곡이 Spotify에서 온 정보인지
  let artKey = null;     // 보이는 앨범 아트가 어느 곡 것인지
  let artQ = 0;          // 보이는 앨범 아트의 품질
  let baseArt = null;    // 고해상도가 아닌 그림 { key, src, q } (고해상도를 끌 때 되돌림)
  let hiResOn = true;    // 설정: 고해상도 앨범 아트 찾기
  let staleKey = null;   // 방금 넘긴 곡. 잠깐 동안은 늦게 도착한 이 곡 정보를 무시한다
  let staleUntil = 0;
  let textTimer = null;

  // ---------- 색 ----------

  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hsl(h, s, l) {
    return `hsl(${(h * 360).toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
  }

  // 그림을 작게 줄여 픽셀 평균을 낸다
  function averageColor(img) {
    const size = 24;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const d = ctx.getImageData(0, 0, size, size).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    return rgbToHsl(r / n / 255, g / n / 255, b / n / 255);
  }

  // 대표 색의 채도를 낮추고 명도를 눌러서 위→아래로 어두워지는 그라데이션
  function gradientFor([h, s]) {
    const sat = Math.min(s, 0.22);
    return `linear-gradient(180deg, ${hsl(h, sat, 0.31)} 0%, ${hsl(h, sat * 0.9, 0.22)} 50%, ${hsl(h, sat * 0.8, 0.14)} 100%)`;
  }

  // ---------- 크로스페이드 ----------

  // 안 보이는 쪽 레이어에 새 내용을 넣고, 그 내용이 다 준비되면(그림은 디코딩까지) 위에 올려 페이드인한다.
  // 준비되기 전에 올리면 그 레이어에 남아 있던 옛 그림(지난 곡 앨범)이 한순간 비친다.
  // apply가 Promise를 돌려주면 그걸 기다린다. 기다리는 사이 또 바뀌면 마지막 것만 보여 준다
  function crossfade(layers, state, apply) {
    const gen = ++state.gen;
    const next = layers[state.idx ^ 1];
    const prev = layers[state.idx];
    let ready;
    try {
      ready = Promise.resolve(apply(next));
    } catch (e) {
      ready = Promise.resolve();
    }
    ready.catch(() => {}).then(() => {
      if (state.gen !== gen) return;
      state.idx ^= 1;
      next.style.transition = 'none'; // 처음부터(투명한 데서) 다시 페이드
      next.classList.remove('on');
      void next.offsetWidth;
      next.style.transition = '';
      next.style.zIndex = 2;
      prev.style.zIndex = 1;
      next.classList.add('on');
      setTimeout(() => {
        if (state.gen === gen) prev.classList.remove('on');
      }, FADE_MS + 50);
    });
  }

  // 그림 레이어에 새 그림을 넣고 디코딩이 끝날 때까지 기다리는 Promise
  function setArtSrc(el, src) {
    el.src = src;
    return el.decode ? el.decode() : Promise.resolve();
  }

  function loadCors(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // ---------- 화면 갱신 ----------

  function setIdle(on) {
    document.body.classList.toggle('idle', on);
  }

  function setArtSize(vh) {
    document.documentElement.style.setProperty('--art-size', `${vh}vh`);
    relayoutLyrics(); // 가사 자리 폭이 바뀌어 줄바꿈이 달라짐
  }

  // 같은 곡인지 제목으로 구분한다 (Windows와 Spotify가 가수 이름을 다르게 줄 때가 있어서)
  function titleKey(title) {
    return (title || '').trim().toLowerCase();
  }

  function isStale(key) {
    return key === staleKey && Date.now() < staleUntil;
  }

  function updateText(t) {
    clearTimeout(textTimer);
    const apply = () => {
      titleEl.textContent = t.title || '';
      subEl.textContent = [t.artist, t.album].filter(Boolean).join(' • ');
      info.classList.remove('hide');
    };
    if (!titleEl.textContent) {
      apply();
      return;
    }
    info.classList.add('hide');
    textTimer = setTimeout(apply, 250); // style.css의 #info.hide 시간
  }

  // 그림 후보를 받는다. 지금 곡의 그림이고, 보이는 것보다 품질이 좋을 때만 바꾼다.
  // (썸네일·Spotify 그림·고해상도가 어떤 순서로 도착해도 좋은 쪽만 남는다)
  function offerArt(key, src, q) {
    if (!src) return;
    if (key === shownKey && q < HI_Q && !(baseArt && baseArt.key === key && baseArt.q >= q)) {
      baseArt = { key, src, q };
    }
    const better = () => key === shownKey && (key !== artKey || q > artQ);
    if (!better()) return;
    loadCors(src).then((img) => {
      if (!better()) return;
      if (key !== artKey) {
        crossfade(bgLayers, bgState, (el) => {
          el.style.background = gradientFor(averageColor(img));
        });
      }
      const newSong = key !== artKey;
      artKey = key;
      artQ = q;
      crossfade(artLayers, artState, (el) => setArtSrc(el, src));
      // 흐린 배경과 빛은 곡이 바뀔 때만 (같은 곡의 더 선명한 그림으로 바뀔 때는 흐려서 차이가 없고, 두 번 출렁이면 어색함)
      if (newSong) setLookArt(src);
      artBox.classList.add('has');
    }, () => {});
  }

  // t: { title, artist, album, art(그림 주소), artQ(품질), fromSpotify }
  function showTrack(t) {
    const key = titleKey(t.title);
    if (!key || isStale(key)) return;
    if (key !== shownKey) {
      shownKey = key;
      nowTrack = t;
      shownSpotify = !!t.fromSpotify;
      updateText(t);
    }
    if (t.art) {
      offerArt(key, t.art, t.artQ || 300);
      upgradeArt(t, t.art);
    }
  }

  // ---------- 고해상도 앨범 아트 (iTunes 검색) ----------
  // Windows 썸네일은 300px, Spotify 그림은 640px이라서, 같은 곡을 iTunes에서 찾아 큰 그림으로 바꾼다.
  // 검색 결과의 앨범 아트를 지금 그림과 비교해서 거의 같은 것만 쓴다.
  // (실측: 같은 앨범은 차이 약 5, 다른 앨범은 40 이상)
  // 못 찾거나 인터넷이 안 되면 지금 그림을 그대로 둔다.

  const MATCH_LIMIT = 20;
  const hiCache = new Map(); // 곡 → Promise<고해상도 주소 또는 null>

  // 이미지를 10x10으로 줄인 색 배열
  function signature(img) {
    const n = 10;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, n, n);
    return ctx.getImageData(0, 0, n, n).data;
  }

  // 두 색 배열의 평균 차이 (0~255)
  function signatureDiff(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i += 4) {
      d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    }
    return d / ((a.length / 4) * 3);
  }

  async function findHiRes(t, refSrc) {
    const want = signature(await loadCors(refSrc));
    // "서쪽 하늘에 - 2025 New Ver." → "서쪽 하늘에",  "A, B" → "A"
    const title = t.title.replace(/\s+-\s+.*$/, '').replace(/\s*[([].*?[)\]]/g, '').trim() || t.title;
    const artist = (t.artist || '').split(/,|&/)[0].trim();
    // 화면에 실제로 그려지는 크기만큼만 받는다 (최대 3000px)
    const px = Math.min(3000, Math.max(600, Math.ceil((artBox.offsetWidth * devicePixelRatio) / 100) * 100));

    for (const term of new Set([`${title} ${artist}`.trim(), title])) {
      const res = await fetch(`https://itunes.apple.com/search?${new URLSearchParams({ term, media: 'music', entity: 'song', limit: '15' })}`);
      const { results } = await res.json();
      const urls = [...new Set(results.map((r) => r.artworkUrl100).filter(Boolean))].slice(0, 10);
      const diffs = await Promise.all(
        urls.map((u) => loadCors(u).then((img) => signatureDiff(want, signature(img)), () => Infinity))
      );
      const best = diffs.indexOf(Math.min(...diffs));
      if (best >= 0 && diffs[best] < MATCH_LIMIT) {
        return urls[best].replace(/\/\d+x\d+bb\./, `/${px}x${px}bb.`);
      }
    }
    return null;
  }

  // 한 곡은 한 번만 찾는다
  function hiResFor(t, refSrc) {
    const key = titleKey(t.title);
    if (!hiCache.has(key)) {
      if (hiCache.size > 100) hiCache.delete(hiCache.keys().next().value);
      hiCache.set(key, findHiRes(t, refSrc).catch(() => {
        hiCache.delete(key); // 인터넷 문제면 다음에 다시 시도
        return null;
      }));
    }
    return hiCache.get(key);
  }

  function upgradeArt(t, refSrc) {
    if (!hiResOn) return;
    const key = titleKey(t.title);
    hiResFor(t, refSrc).then((url) => {
      if (url && hiResOn) offerArt(key, url, HI_Q);
    });
  }

  // 다음 곡들의 그림을 미리 받아 둔다 (곡이 바뀌면 페이드 한 번에 선명한 그림이 보이게)
  // 가사는 바로 다음 곡만 (가사 사이트에 요청이 몰리지 않게)
  function prefetch(items) {
    for (const t of items) {
      if (t.art) loadCors(t.art).catch(() => {});
      if (hiResOn && t.image) {
        hiResFor({ title: t.name, artist: t.artists }, t.image)
          .then((url) => url && loadCors(url).catch(() => {}));
      }
    }
    if (lyricsOn && items[0] && items[0].uri) lyricsFor(items[0]);
  }

  function setHiRes(on) {
    hiResOn = on;
    if (on) {
      if (nowTrack && baseArt && baseArt.key === shownKey) upgradeArt(nowTrack, baseArt.src);
    } else if (artQ >= HI_Q && baseArt && baseArt.key === artKey) {
      artQ = baseArt.q;
      crossfade(artLayers, artState, (el) => setArtSrc(el, baseArt.src));
    }
  }

  // ---------- Spotify 조작 (도우미 프로그램) ----------
  // 배경화면은 Spotify를 직접 조작할 수 없어서, helper/spotify_helper.py 가
  // 127.0.0.1:8974 에서 Spotify Web API를 대신 불러 준다.

  const HELPER = 'http://127.0.0.1:8974';
  const controlsEl = document.getElementById('controls');
  const playBtn = document.getElementById('btn-play');
  const repeatBtn = document.getElementById('btn-repeat');
  const shuffleBtn = document.getElementById('btn-shuffle');
  const panelMsg = document.getElementById('panel-msg');
  const listQueue = document.getElementById('list-queue');
  const listPlaylists = document.getElementById('list-playlists');
  const listSearch = document.getElementById('list-search');
  const searchBox = document.getElementById('search-box');
  const searchText = document.getElementById('search-text');
  const searchResults = document.getElementById('search-results');
  const LISTS = { queue: listQueue, playlists: listPlaylists, search: listSearch };

  let helperReady = false;
  let helperKnown = false;  // 도우미 상태를 한 번이라도 확인했는지
  let hostTrack = null;     // Windows(WE/Lively)가 마지막으로 알려 준 곡
  let hostPlaying = null;   // Windows가 마지막으로 알려 준 재생 상태
  let pokeTimer = null;
  let isPlaying = false;
  let contextUri = null;    // 지금 재생 중인 플레이리스트/앨범
  let currentUri = null;    // 지금 곡 (바뀌면 대기열을 새로 받음)
  let queueData = null;     // 마지막으로 받은 대기열 { current, queue }
  let playHoldUntil = 0;    // 재생/일시정지를 누른 직후엔 옛 상태로 되돌리지 않음
  let repeatState = 'off';  // off / context(전체 반복) / track(한 곡 반복)
  let repeatHoldUntil = 0;  // 반복을 누른 직후엔 옛 상태로 되돌리지 않음
  let shuffleOn = false;
  let shuffleHoldUntil = 0; // 셔플을 누른 직후엔 옛 상태로 되돌리지 않음
  let prog = { pos: 0, dur: 0, at: 0, playing: false }; // 재생 위치(ms): at 시각에 pos였음
  let seekHoldUntil = 0;    // 재생바를 옮긴 직후엔 옛 위치로 되돌리지 않음
  let dragging = false;
  let dragPos = 0;
  let playlistsAt = 0;      // 플레이리스트를 마지막으로 받은 시각
  let msgTimer = null;
  let endTimer = null;      // 곡이 끝날 즈음 Spotify에 한 번 더 묻는 타이머
  // 탭(웹) 버전은 도우미 프로그램 대신 web.js가 브라우저에서 직접 Spotify를 부른다 (tablet 폴더)
  const webMode = !!window.webHelper;
  let fakeHelper = window.webHelper || null; // 테스트 모드의 가짜 도우미, 또는 탭 버전의 web.js

  async function callHelper(path, body) {
    if (fakeHelper) return fakeHelper(path, body);
    let res;
    try {
      res = await fetch(HELPER + path, body === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' }, // preflight 없이 보내려고 text/plain
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('도우미 프로그램에 연결할 수 없어요');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `오류 ${res.status}`);
    return data;
  }

  // ms를 주면 잠깐만 보여 준다
  function showMsg(text, ms) {
    clearTimeout(msgTimer);
    panelMsg.textContent = text || '';
    panelMsg.classList.toggle('on', !!text);
    if (text && ms) msgTimer = setTimeout(() => showMsg(''), ms);
  }

  function setPlaying(on) {
    isPlaying = on;
    playBtn.classList.toggle('playing', on);
    playBtn.setAttribute('aria-label', on ? '일시정지' : '재생');
    if (prog.playing !== on) setProgress(progressNow(), prog.dur, on); // 멈추면 재생바도 멈춤
  }

  // ---------- 재생바 ----------

  const progEl = document.getElementById('progress');
  const progHit = progEl.querySelector('.hit');
  const progBar = progEl.querySelector('.bar');
  const progFill = progEl.querySelector('.fill');
  const timeNow = document.getElementById('time-now');
  const timeEnd = document.getElementById('time-end');

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Spotify에 묻지 않는 사이에는 흐른 시간만큼 앞으로 계산한다
  function progressNow() {
    if (!prog.playing) return prog.pos;
    return Math.min(prog.dur, prog.pos + (performance.now() - prog.at));
  }

  function setProgress(pos, dur, playing) {
    prog = { pos: pos || 0, dur: dur || 0, at: performance.now(), playing };
    drawProgress();
  }

  // 바뀐 것만 고친다 (그대로면 화면을 다시 그리지 않음)
  let shownProgress = '';
  function drawProgress() {
    const pos = dragging ? dragPos : progressNow();
    const ratio = prog.dur ? Math.min(1, pos / prog.dur) : 0;
    const width = `${(ratio * 100).toFixed(2)}%`;
    const now = fmtTime(pos);
    const end = fmtTime(prog.dur);
    const key = `${width}|${now}|${end}`;
    if (key === shownProgress) return;
    shownProgress = key;
    progFill.style.width = width;
    timeNow.textContent = now;
    timeEnd.textContent = end;
  }

  // 1초에 한 번만 움직인다. 부드럽게 이어지는 애니메이션은 배경화면을 계속 다시 그리게 해서 뺐다.
  setInterval(drawProgress, 1000);

  function ratioAt(e) {
    const r = progBar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  // 끄는 중에는 막대 밖으로 나가도 따라가도록 window에서 받는다
  progHit.addEventListener('pointerdown', (e) => {
    if (!helperReady || !prog.dur) return;
    dragging = true;
    progEl.classList.add('dragging');
    dragPos = ratioAt(e) * prog.dur;
    drawProgress();
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragPos = ratioAt(e) * prog.dur;
    drawProgress();
  });
  window.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    progEl.classList.remove('dragging');
    const pos = Math.round(ratioAt(e) * prog.dur);
    setProgress(pos, prog.dur, isPlaying);
    seekHoldUntil = Date.now() + 2000;
    control('seek', { position_ms: pos });
  });
  window.addEventListener('pointercancel', () => {
    dragging = false;
    progEl.classList.remove('dragging');
    drawProgress();
  });

  // ---------- 볼륨 ----------

  const volEl = document.getElementById('volume');
  const volHit = volEl.querySelector('.hit');
  const volBar = volEl.querySelector('.bar');
  const volFill = volEl.querySelector('.fill');
  const muteBtn = document.getElementById('btn-mute');
  let volume = 0;
  let lastVolume = 50;   // 음소거를 풀 때 돌아갈 볼륨
  let volHoldUntil = 0;  // 볼륨을 바꾼 직후엔 옛 값으로 되돌리지 않음
  let volDragging = false;
  let volSentAt = 0;

  function setVolume(v) {
    volume = Math.round(Math.min(100, Math.max(0, v)));
    volFill.style.width = `${volume}%`;
    muteBtn.classList.toggle('vol-muted', volume === 0);
    muteBtn.classList.toggle('vol-low', volume > 0 && volume < 50);
    muteBtn.classList.toggle('vol-high', volume >= 50);
    muteBtn.setAttribute('aria-label', volume === 0 ? '음소거 해제' : '음소거');
  }

  function sendVolume() {
    volHoldUntil = Date.now() + 2000;
    volSentAt = Date.now();
    control('volume', { volume_percent: volume });
  }

  function volumeAt(e) {
    const r = volBar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100;
  }

  volHit.addEventListener('pointerdown', (e) => {
    if (!helperReady) return;
    volDragging = true;
    volEl.classList.add('dragging');
    setVolume(volumeAt(e));
  });
  window.addEventListener('pointermove', (e) => {
    if (!volDragging) return;
    setVolume(volumeAt(e));
    if (Date.now() - volSentAt > 300) sendVolume(); // 끄는 중에도 소리가 따라 바뀌게
  });
  window.addEventListener('pointerup', () => {
    if (!volDragging) return;
    volDragging = false;
    volEl.classList.remove('dragging');
    if (volume > 0) lastVolume = volume;
    sendVolume();
  });
  muteBtn.addEventListener('click', () => {
    if (!helperReady) return;
    if (volume > 0) {
      lastVolume = volume;
      setVolume(0);
    } else {
      setVolume(lastVolume || 50);
    }
    sendVolume();
  });

  const REPEAT_NEXT = { off: 'context', context: 'track', track: 'off' };
  const REPEAT_LABEL = { off: '반복 끔', context: '전체 반복', track: '한 곡 반복' };

  function setRepeat(state) {
    if (!REPEAT_LABEL[state]) state = 'off';
    repeatState = state;
    repeatBtn.classList.toggle('repeat-context', state === 'context');
    repeatBtn.classList.toggle('repeat-track', state === 'track');
    repeatBtn.setAttribute('aria-label', REPEAT_LABEL[state]);
  }

  function setShuffle(on) {
    shuffleOn = on;
    shuffleBtn.classList.toggle('on', on);
    shuffleBtn.setAttribute('aria-label', on ? '셔플 켜짐' : '셔플 끔');
  }

  // ---------- 좋아요 ----------
  // 하트를 누르면 '좋아요 표시한 곡'에 저장/삭제. 좋아요 여부는 곡이 바뀔 때마다 Spotify에 묻는다.

  const likeBtn = document.getElementById('btn-like');
  const likedCache = new Map(); // 곡 uri → true/false
  let likeUri = null;           // 하트가 가리키는 곡
  let likeNeedLogin = false;    // 좋아요 권한이 없어서 다시 로그인해야 함

  function drawLike() {
    const known = helperReady && !!likeUri && (likeNeedLogin || likedCache.has(likeUri));
    const on = known && likedCache.get(likeUri) === true;
    likeBtn.classList.toggle('known', known);
    likeBtn.classList.toggle('liked', on);
    likeBtn.setAttribute('aria-label', on ? '좋아요 취소' : '좋아요');
  }

  // force가 아니면 이미 아는 곡은 건너뛴다 (다음 곡 미리 묻기용)
  async function fetchLiked(uris, force) {
    const want = uris.filter((u) => u && u.startsWith('spotify:track:') && (force || !likedCache.has(u)));
    if (!want.length) return;
    try {
      const r = await callHelper(`/api/liked?${new URLSearchParams({ uris: want.join(',') })}`);
      likeNeedLogin = !!r.need_login;
      for (const [u, v] of Object.entries(r.liked || {})) likedCache.set(u, v);
      if (likedCache.size > 300) likedCache.delete(likedCache.keys().next().value);
    } catch (e) {
      // 못 물어보면 하트를 숨긴 채로 둔다
    }
    drawLike();
  }

  function setLikeTrack(uri) {
    if (uri === likeUri) return;
    likeUri = uri;
    drawLike();
    if (uri) fetchLiked([uri], true); // 앱에서 바꿨을 수도 있으니 지금 곡은 늘 다시 묻는다
  }

  likeBtn.addEventListener('click', async () => {
    const uri = likeUri;
    if (!helperReady || !uri) return;
    const had = likedCache.has(uri);
    const prev = likedCache.get(uri);
    const on = prev !== true;
    likedCache.set(uri, on); // 바로 바뀐 것처럼 보이게
    drawLike();
    if (on) {
      likeBtn.classList.remove('pop');
      void likeBtn.offsetWidth;
      likeBtn.classList.add('pop');
    }
    try {
      await callHelper('/api/like', { uri, on });
      showMsg(on ? '좋아요 표시한 곡에 추가했어요' : '좋아요 표시한 곡에서 뺐어요', 2000);
    } catch (e) {
      if (had) likedCache.set(uri, prev);
      else likedCache.delete(uri);
      drawLike();
      showMsg(e.message, 6000);
    }
  });

  // ---------- 가사 ----------
  // Spotify는 가사를 주지 않아서, 도우미가 LRCLIB(무료 가사 모음)에서 시간이 적힌 가사를 받아 온다.
  // 시간이 적힌 가사가 없는 곡은 가사를 띄우지 않는다.

  const lyricsEl = document.getElementById('lyrics');
  const lyricsInner = lyricsEl.querySelector('.inner');
  const LYRIC_LEAD = 250;        // 줄을 살짝 일찍 바꿔야 노래와 맞아 보임
  const lyricsCache = new Map(); // 곡 uri → Promise<[[ms, 가사], ...] 또는 null>
  let lyricsOn = true;           // 설정: 가사 표시
  let lyricsTrack = null;        // 가사를 보여 줄 곡 (도우미가 준 곡 정보)
  let lyricsUri;                 // 가사를 요청한 곡
  let lyricLines = null;         // 보이는 가사
  let lyricIdx = -2;             // 밝게 보이는 줄 (-1: 첫 줄 전)
  let lyricsGen = 0;

  function lyricsFor(t) {
    if (!lyricsCache.has(t.uri)) {
      if (lyricsCache.size > 100) lyricsCache.delete(lyricsCache.keys().next().value);
      const q = new URLSearchParams({ track: t.name || '', artist: t.artists || '', album: t.album || '', duration: t.duration_ms || 0 });
      lyricsCache.set(t.uri, callHelper(`/api/lyrics?${q}`).then((r) => r.lines || null, () => {
        lyricsCache.delete(t.uri); // 가사 사이트가 잠깐 안 되면 다음에 다시 시도
        return undefined;
      }));
    }
    return lyricsCache.get(t.uri);
  }

  // t: 도우미가 준 곡 정보 (없으면 가사를 지움)
  function setLyricsTrack(t) {
    lyricsTrack = t;
    const uri = lyricsOn && t ? t.uri : null;
    if (uri === lyricsUri) return;
    lyricsUri = uri;
    const gen = ++lyricsGen;
    lyricsEl.classList.remove('on'); // 옛 가사는 먼저 사라지게
    const wait = new Promise((r) => setTimeout(r, 400)); // style.css의 #lyrics 페이드 시간
    Promise.all([uri ? lyricsFor(t) : null, wait]).then(([lines]) => {
      if (gen !== lyricsGen) return;
      renderLyrics(lines);
      if (lines === undefined) {
        // 못 받아 왔으면 20초 뒤 같은 곡이면 다시 시도
        setTimeout(() => {
          if (gen !== lyricsGen) return;
          lyricsUri = undefined;
          setLyricsTrack(lyricsTrack);
        }, 20000);
      }
    });
  }

  function renderLyrics(lines) {
    lyricLines = lines && lines.length ? lines : null;
    lyricsInner.replaceChildren(...(lyricLines || []).map(([, text]) => {
      const el = document.createElement('div');
      el.className = 'line';
      el.textContent = text || '♪'; // 빈 줄은 간주
      return el;
    }));
    lyricIdx = -2;
    lyricsInner.style.transition = 'none'; // 새 가사는 제자리에서 바로 시작
    drawLyrics();
    void lyricsInner.offsetWidth;
    lyricsInner.style.transition = '';
    lyricsEl.classList.toggle('on', !!lyricLines);
  }

  function drawLyrics() {
    if (!lyricLines) return;
    const pos = (dragging ? dragPos : progressNow()) + LYRIC_LEAD;
    let lo = 0;
    let hi = lyricLines.length - 1;
    let i = -1; // pos보다 앞에서 시작한 마지막 줄
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (lyricLines[m][0] <= pos) {
        i = m;
        lo = m + 1;
      } else {
        hi = m - 1;
      }
    }
    if (i === lyricIdx) return;
    const els = lyricsInner.children;
    if (els[lyricIdx]) els[lyricIdx].classList.remove('on');
    if (els[i]) els[i].classList.add('on');
    lyricIdx = i;
    const el = els[Math.max(0, i)];
    const y = lyricsEl.clientHeight * 0.38 - (el.offsetTop + el.offsetHeight / 2);
    lyricsInner.style.transform = `translateY(${y.toFixed(1)}px)`;
  }

  function relayoutLyrics() {
    lyricIdx = -2;
    drawLyrics();
  }

  function setLyricsOn(on) {
    lyricsOn = on;
    setLyricsTrack(lyricsTrack);
  }

  setInterval(drawLyrics, 200);
  window.addEventListener('resize', relayoutLyrics);

  // ---------- Windows 미디어 신호 ----------
  // WE/Lively는 Spotify뿐 아니라 유튜브 등 소리 나는 모든 앱의 정보를 넘겨준다 (어느 앱인지는 모름).
  // 그래서 도우미가 연결돼 있으면 Spotify 정보만 표시하고, 이 신호는 "뭔가 바뀌었다"는 알림으로만 쓴다.
  // 도우미가 꺼져 있을 때만 이 정보를 그대로 표시한다.

  function onHostTrack(t) {
    hostTrack = t;
    if (helperReady) pokePlayer();
    else if (helperKnown) showTrack(t);
  }

  function onHostPlayback(playing) {
    hostPlaying = playing;
    if (helperReady) {
      pokePlayer();
      return;
    }
    if (Date.now() < playHoldUntil) return;
    setIdle(!playing);
    setPlaying(playing);
  }

  // 신호가 몰려 와도 Spotify에는 한 번만 묻는다
  function pokePlayer() {
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(refreshPlayer, 150);
  }

  // 아무 곡도 표시하지 않는다 (배경만 남김)
  function clearTrack() {
    shownKey = null;
    nowTrack = null;
    shownSpotify = false;
    artKey = null;
    artQ = 0;
    clearTimeout(textTimer);
    titleEl.textContent = '';
    subEl.textContent = '';
    artBox.classList.remove('has');
    setLookArt(null);
    setProgress(0, 0, false);
    setLikeTrack(null);
    setLyricsTrack(null);
    crossfade(bgLayers, bgState, (el) => {
      el.style.background = 'linear-gradient(180deg, #2b3131 0%, #1c2121 50%, #121515 100%)';
    });
  }

  // 도우미가 준 곡 정보를 화면용으로
  function fromSpotify(t) {
    return { title: t.name, artist: t.artists, album: t.album, art: t.art || t.image, artQ: 640, fromSpotify: true };
  }

  // action: 오른쪽 작은 버튼 { icon(SVG path), label, onClick }
  function row({ image, title, sub, now, onClick, action }) {
    const el = document.createElement('div');
    el.className = `row${now ? ' now' : ''}${onClick ? ' click' : ''}`;
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    if (image) img.src = image;
    const text = document.createElement('div');
    text.className = 'text';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = title || '';
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = sub || '';
    text.append(t, s);
    el.append(img, text);
    if (action) {
      const btn = document.createElement('button');
      btn.className = 'row-action';
      btn.setAttribute('aria-label', action.label);
      btn.title = action.label;
      btn.innerHTML = `<svg viewBox="0 0 16 16"><path d="${action.icon}"/></svg>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // 줄 전체 클릭(재생)으로 번지지 않게
        action.onClick();
      });
      el.append(btn);
    }
    if (onClick) el.addEventListener('click', onClick);
    return el;
  }

  function label(className, text) {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    return el;
  }

  function renderQueue(q) {
    queueData = q;
    listQueue.replaceChildren();
    if (!q || !q.current) {
      listQueue.append(label('empty', '재생 중인 곡이 없어요'));
      return;
    }
    const c = q.current;
    listQueue.append(label('section', '지금 재생 중'), row({ image: c.image, title: c.name, sub: c.artists, now: true }));
    if (q.queue.length) listQueue.append(label('section', '다음 곡'));
    q.queue.forEach((t, i) => {
      listQueue.append(row({
        image: t.image,
        title: t.name,
        sub: t.artists,
        onClick: () => {
          const ctx = contextUri;
          jumpTo(i);
          play({ context_uri: ctx, offset_uri: t.uri, skip: i + 1 });
        },
      }));
    });
    updateThumb();
    prefetch(q.queue.slice(0, 2));
    fetchLiked(q.queue.slice(0, 2).map((t) => t.uri)); // 다음 곡으로 넘기면 하트가 바로 보이게
  }

  // '좋아요 표시한 곡'은 Spotify가 그림을 주지 않아서 직접 그린다 (보라→연두 그라데이션에 흰 하트)
  const LIKED_ART = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
    + '<linearGradient id="g" x2="1" y2="1"><stop stop-color="#450af5"/><stop offset="1" stop-color="#c4efd9"/></linearGradient>'
    + '<rect width="24" height="24" fill="url(#g)"/>'
    + `<path fill="#fff" transform="translate(6.6 6.5) scale(.45)" d="${likeBtn.querySelector('.i-on path').getAttribute('d')}"/></svg>`);

  function renderPlaylists(list) {
    listPlaylists.replaceChildren();
    if (!list || !list.length) {
      listPlaylists.append(label('empty', '플레이리스트가 없어요'));
      return;
    }
    for (const p of list) {
      const el = row({
        image: p.image || (p.liked ? LIKED_ART : null),
        title: p.name,
        sub: [p.owner, p.total != null ? `${p.total}곡` : ''].filter(Boolean).join(' • '),
        onClick: () => {
          contextUri = p.uri; // 누른 플레이리스트를 바로 초록색으로
          markPlaylists();
          play({ context_uri: p.uri });
        },
      });
      el.dataset.uri = p.uri;
      listPlaylists.append(el);
    }
    markPlaylists();
    updateThumb();
  }

  function markPlaylists() {
    for (const el of listPlaylists.children) {
      el.classList.toggle('now', !!contextUri && el.dataset.uri === contextUri);
    }
  }

  // 대기열의 i번째 곡으로 넘어간다. Spotify 응답을 기다리지 않고 화면부터 바꾼다.
  function jumpTo(i) {
    const q = queueData;
    const t = q && q.queue[i];
    if (!t) return;
    renderQueue({ current: t, queue: q.queue.slice(i + 1) });
    showNow(t);
  }

  // 곡 t를 지금 재생하는 것처럼 화면부터 바꾼다 (Spotify 응답은 나중에 맞춤)
  function showNow(t) {
    staleKey = shownKey;
    staleUntil = Date.now() + 3000;
    playHoldUntil = Date.now() + 2000;
    currentUri = t.uri;
    showTrack(fromSpotify(t));
    setPlaying(true);
    setProgress(0, t.duration_ms, true);
    setIdle(false);
    setLikeTrack(t.uri);
    setLyricsTrack(t);
    setTimeout(refreshQueue, 1500); // 대기열 새로 받기
  }

  // ---------- 검색 ----------

  const ICON_ADD = 'M15.25 8a.75.75 0 0 1-.75.75H8.75v5.75a.75.75 0 0 1-1.5 0V8.75H1.5a.75.75 0 0 1 0-1.5h5.75V1.5a.75.75 0 0 1 1.5 0v5.75h5.75a.75.75 0 0 1 .75.75z';
  let searching = false;
  let lastQuery = '';

  function renderSearch(list, query) {
    searchResults.replaceChildren();
    if (!list.length) {
      searchResults.append(label('empty', `"${query}" 검색 결과가 없어요`));
    }
    for (const t of list) {
      searchResults.append(row({
        image: t.image,
        title: t.name,
        sub: [t.artists, t.album].filter(Boolean).join(' • '),
        // 누르면 그 곡부터 앨범을 이어서 재생
        onClick: () => {
          showNow(t);
          play({ context_uri: t.album_uri, offset_uri: t.uri });
        },
        action: {
          icon: ICON_ADD,
          label: '대기열에 추가',
          onClick: async () => {
            try {
              await callHelper('/api/control', { action: 'queue', uri: t.uri });
              showMsg(`"${t.name}"을(를) 대기열에 추가했어요`, 2500);
              setTimeout(refreshQueue, 500);
            } catch (e) {
              showMsg(e.message, 4000);
            }
          },
        },
      }));
    }
    listSearch.scrollTop = 0;
    updateThumb();
  }

  // 도우미가 검색칸의 글자 자리에 입력칸을 겹쳐 띄우도록, 그 자리를 화면 크기에 대한 비율로 알려 준다
  // (배경화면은 화면 전체를 덮으므로 비율이면 화면 배율과 상관없이 맞음)
  function searchRect() {
    const box = searchBox.getBoundingClientRect();
    const text = searchText.getBoundingClientRect();
    const vh = innerHeight / 100;
    const f = (v, size) => (v / size).toFixed(5);
    return new URLSearchParams({
      x0: f(text.left, innerWidth),
      y0: f(box.top + 0.35 * vh, innerHeight), // 흰 테두리(0.2vh)는 가리지 않게
      x1: f(box.right - 1.6 * vh, innerWidth),
      y1: f(box.bottom - 0.35 * vh, innerHeight),
    });
  }

  // 검색칸을 누르면 도우미가 그 자리에 입력칸을 띄우고, 입력이 끝날 때까지 기다린다
  searchBox.addEventListener('click', async () => {
    if (!helperReady || searching) return;
    searching = true;
    listSearch.scrollTop = 0; // 검색칸이 목록 위로 가려지지 않게
    searchBox.classList.add('typing');
    showMsg('검색어를 입력하고 Enter를 누르세요 · Esc: 닫기');
    try {
      const { query } = await callHelper(`/api/search/prompt?${searchRect()}`);
      searchBox.classList.remove('typing');
      showMsg('');
      if (query) {
        lastQuery = query;
        renderSearch(await callHelper(`/api/search?${new URLSearchParams({ q: query })}`), query);
      }
    } catch (e) {
      showMsg(e.message, 4000);
    }
    searchBox.classList.remove('typing');
    searchText.textContent = lastQuery || '노래, 가수, 앨범 검색';
    searchBox.classList.toggle('has-query', !!lastQuery);
    searching = false;
    wake(); // 결과를 볼 시간 동안은 패널을 숨기지 않음
  });

  async function refreshQueue() {
    try {
      renderQueue(await callHelper('/api/queue'));
    } catch (e) {
      showMsg(e.message, 4000);
    }
  }

  async function refreshPlaylists() {
    playlistsAt = Date.now();
    try {
      renderPlaylists(await callHelper('/api/playlists'));
    } catch (e) {
      showMsg(e.message, 4000);
    }
  }

  async function refreshPlayer() {
    let p;
    const t0 = performance.now();
    try {
      p = await callHelper('/api/player');
    } catch (e) {
      return;
    }
    const lag = (performance.now() - t0) / 2; // Spotify가 재생 위치를 잰 뒤 여기 오기까지 걸린 시간 (가사 싱크용)
    if (!p.active) {
      setPlaying(false);
      setLyricsTrack(null);
      // Spotify 곡을 듣다 멈췄으면 그 곡을 어둡게 남기고, 다른 앱 정보가 떠 있으면 지운다
      if (shownSpotify) setIdle(true);
      else if (shownKey) clearTrack();
      if (currentUri !== '') {
        currentUri = '';
        renderQueue(null);
      }
      return;
    }
    if (Date.now() >= playHoldUntil) {
      setPlaying(p.is_playing);
      setIdle(!p.is_playing);
    }
    if (Date.now() >= repeatHoldUntil) setRepeat(p.repeat);
    if (Date.now() >= shuffleHoldUntil) setShuffle(!!p.shuffle);
    volEl.classList.toggle('unsupported', p.supports_volume === false);
    if (p.volume != null && Date.now() >= volHoldUntil && !volDragging) {
      setVolume(p.volume);
      if (p.volume > 0) lastVolume = p.volume;
    }
    if (p.context_uri !== contextUri) {
      contextUri = p.context_uri;
      markPlaylists();
    }
    const t = p.track;
    if (!t || isStale(titleKey(t.name))) return;
    if (Date.now() >= seekHoldUntil && !dragging) {
      setProgress(p.progress_ms + (isPlaying ? lag : 0), p.duration_ms || t.duration_ms, isPlaying);
    }
    // 곡이 끝날 즈음 한 번 더 묻는다 (다음 곡으로 넘어간 게 바로 보이게).
    // 끝났는데 Spotify가 아직 옛 곡을 알려 주면 5초 동안은 0.8초마다 다시 묻는다
    clearTimeout(endTimer);
    const left = (p.duration_ms || t.duration_ms) - p.progress_ms;
    if (p.is_playing && left > -5000) endTimer = setTimeout(refreshPlayer, left > 0 ? left + 300 : 800);
    showTrack(fromSpotify(t));
    setLikeTrack(t.uri);
    setLyricsTrack(t);
    if (t.uri !== currentUri) {
      currentUri = t.uri;
      refreshQueue();
    }
  }

  // 5초마다: 도우미가 켜져 있는지, 로그인됐는지 보고 재생 상태를 맞춘다
  async function checkHelper() {
    let s = null;
    try {
      s = await callHelper('/api/status');
    } catch (e) {
      s = null;
    }
    const wasReady = helperReady;
    const wasKnown = helperKnown;
    helperKnown = true;
    if (!s || !s.ready) {
      helperReady = false;
      controlsEl.classList.add('offline');
      volEl.classList.add('offline');
      drawLike();
      setLyricsTrack(null); // 도우미 없이는 재생 위치를 몰라서 가사를 맞출 수 없음
      showMsg(!s
        ? '도우미 프로그램이 꺼져 있어요.\nhelper 폴더의 spotify_helper.py 를 실행해 주세요.'
        : s.msg || 'Spotify 로그인이 필요해요.\n브라우저에서 http://127.0.0.1:8974 를 열어 주세요.');
      // 도우미 없이는 Windows 정보를 그대로 쓴다
      if (wasReady || !wasKnown) {
        if (hostTrack) showTrack(hostTrack);
        if (hostPlaying !== null) {
          setIdle(!hostPlaying);
          setPlaying(hostPlaying);
        }
      }
      return;
    }
    if (!helperReady) {
      helperReady = true;
      controlsEl.classList.remove('offline');
      volEl.classList.remove('offline');
      showMsg('');
      currentUri = null;
      playlistsAt = 0; // 도우미가 새로 켜졌으면 플레이리스트도 다시 받는다
      drawLike();
    }
    refreshPlayer();
    if (Date.now() - playlistsAt > 5 * 60 * 1000) refreshPlaylists();
    if (likeNeedLogin && likeUri) fetchLiked([likeUri], true); // 다시 로그인했는지 확인
  }

  // 조작 후 Spotify 상태를 두 번 확인한다 (바로 한 번, 늦게 반영될 때를 대비해 한 번 더)
  function refreshAfterAction() {
    setTimeout(refreshPlayer, 300);
    setTimeout(refreshPlayer, 1500);
  }

  async function control(action, extra) {
    try {
      await callHelper('/api/control', { action, ...extra });
    } catch (e) {
      staleUntil = 0;
      playHoldUntil = 0;
      repeatHoldUntil = 0;
      shuffleHoldUntil = 0;
      showMsg(e.message, 4000);
    }
    refreshAfterAction();
  }

  async function play(body) {
    try {
      await callHelper('/api/play', body);
    } catch (e) {
      staleUntil = 0;
      showMsg(e.message, 4000);
    }
    refreshAfterAction();
  }

  document.getElementById('btn-prev').addEventListener('click', () => {
    setProgress(0, prog.dur, isPlaying); // 이전 곡이든 처음부터든 0:00에서 시작
    control('previous');
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    jumpTo(0);
    control('next');
  });
  playBtn.addEventListener('click', () => {
    const next = !isPlaying;
    setPlaying(next); // 바로 바뀐 것처럼 보이게
    setIdle(!next);
    playHoldUntil = Date.now() + 2000;
    control(next ? 'play' : 'pause');
  });
  repeatBtn.addEventListener('click', () => {
    const state = REPEAT_NEXT[repeatState];
    setRepeat(state); // 바로 바뀐 것처럼 보이게
    repeatHoldUntil = Date.now() + 2000;
    control('repeat', { state });
  });
  shuffleBtn.addEventListener('click', () => {
    const on = !shuffleOn;
    setShuffle(on); // 바로 바뀐 것처럼 보이게
    shuffleHoldUntil = Date.now() + 2000;
    control('shuffle', { state: on });
    setTimeout(refreshQueue, 800); // 셔플을 바꾸면 다음 곡 순서가 바뀜
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
      for (const [name, l] of Object.entries(LISTS)) l.classList.toggle('on', tab.dataset.tab === name);
      updateThumb();
    });
  });

  // ---------- 재생목록 스크롤 ----------
  // Wallpaper Engine은 마우스 휠을 배경화면에 넘겨주지 않고, 기본 스크롤바 끌기도 먹지 않는다.
  // 그래서 목록을 꾹 눌러 끌거나, 직접 만든 스크롤바를 끌어서 내린다. (휠은 되는 곳에선 그대로 됨)

  const scrollTrack = document.querySelector('.scroll-track');
  const scrollThumb = document.querySelector('.scroll-thumb');
  let listDrag = null;       // { mode: 'list' | 'thumb', list, y0, top0, moved }
  let suppressClick = false; // 끌다가 손을 뗀 곳의 곡이 눌리지 않게

  function activeList() {
    return Object.values(LISTS).find((l) => l.classList.contains('on')) || listQueue;
  }

  function updateThumb() {
    const l = activeList();
    const max = l.scrollHeight - l.clientHeight;
    scrollTrack.classList.toggle('hidden', max <= 1);
    if (max <= 1) return;
    const trackH = scrollTrack.clientHeight;
    const h = Math.max(trackH * 0.08, trackH * (l.clientHeight / l.scrollHeight));
    scrollThumb.style.height = `${h}px`;
    scrollThumb.style.transform = `translateY(${(trackH - h) * (l.scrollTop / max)}px)`;
  }

  function startListDrag(e, mode) {
    const l = activeList();
    listDrag = { mode, list: l, y0: e.clientY, top0: l.scrollTop, moved: mode === 'thumb' };
    if (mode === 'thumb') scrollTrack.classList.add('dragging');
  }

  function endListDrag() {
    listDrag = null;
    scrollTrack.classList.remove('dragging');
  }

  for (const l of Object.values(LISTS)) {
    l.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') startListDrag(e, 'list'); // 손가락으로 끄는 건 브라우저가 스크롤해 줌
    });
    l.addEventListener('scroll', updateThumb);
    l.addEventListener('click', (e) => {
      if (!suppressClick) return;
      e.stopPropagation();
      suppressClick = false;
    }, true);
  }

  scrollThumb.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    startListDrag(e, 'thumb');
  });

  // 스크롤바의 빈 곳을 누르면 그 위치로 이동하고, 그대로 끌 수도 있다
  scrollTrack.addEventListener('pointerdown', (e) => {
    if (e.target !== scrollTrack) return;
    const l = activeList();
    const r = scrollTrack.getBoundingClientRect();
    l.scrollTop = ((e.clientY - r.top) / r.height) * (l.scrollHeight - l.clientHeight);
    startListDrag(e, 'thumb');
  });

  window.addEventListener('pointermove', (e) => {
    if (!listDrag) return;
    const dy = e.clientY - listDrag.y0;
    if (!listDrag.moved && Math.abs(dy) < 5) return; // 5px 미만은 그냥 누른 것
    listDrag.moved = true;
    const l = listDrag.list;
    if (listDrag.mode === 'thumb') {
      const range = Math.max(1, scrollTrack.clientHeight - scrollThumb.offsetHeight);
      l.scrollTop = listDrag.top0 + dy * ((l.scrollHeight - l.clientHeight) / range);
    } else {
      l.scrollTop = listDrag.top0 - dy;
    }
  });

  window.addEventListener('pointerup', () => {
    if (listDrag && listDrag.mode === 'list' && listDrag.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0); // 클릭이 안 오면 바로 풀림
    }
    endListDrag();
  });
  window.addEventListener('pointercancel', endListDrag);
  window.addEventListener('resize', updateThumb);

  // ---------- 안 쓸 때 버튼 숨기기 ----------
  // 마우스가 hideDelay 동안 안 움직이면 버튼·재생바·볼륨·패널을 숨긴다 (앨범 아트·곡 정보·가사·시계는 남김).
  // 끄는 중이거나 검색어를 입력하는 중에는 숨기지 않는다.

  let hideDelay = webMode ? 0 : 4000; // 0이면 숨기지 않음 (탭 버전은 늘 보이게)
  let lastActive = performance.now();

  function wake() {
    lastActive = performance.now();
    document.body.classList.remove('calm');
  }

  window.addEventListener('pointermove', wake);
  window.addEventListener('pointerdown', wake);
  setInterval(() => {
    if (dragging || volDragging || listDrag || searching) lastActive = performance.now();
    document.body.classList.toggle('calm', hideDelay > 0 && performance.now() - lastActive > hideDelay);
  }, 500);

  function setHideDelay(sec) {
    hideDelay = Math.max(0, Number(sec) || 0) * 1000;
    wake();
  }

  // ---------- 시계 ----------

  const clockEl = document.getElementById('clock');
  const clockTime = document.getElementById('clock-time');
  const clockDate = document.getElementById('clock-date');
  const dateFmt = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
  let timeFmt = null;
  let clockShown = '';

  function setClock24(on) {
    timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', hourCycle: on ? 'h23' : 'h12' });
    clockShown = '';
    drawClock();
  }

  function drawClock() {
    const now = new Date();
    const parts = timeFmt.formatToParts(now);
    const key = parts.map((p) => p.value).join('') + dateFmt.format(now);
    if (key === clockShown) return;
    clockShown = key;
    // "오후 3:42" → 오전/오후만 작게
    const ampm = parts.find((p) => p.type === 'dayPeriod');
    const time = parts.filter((p) => p.type === 'hour' || p.type === 'minute' || (p.type === 'literal' && p.value.trim()))
      .map((p) => p.value).join('');
    const nodes = [time];
    if (ampm) {
      const el = document.createElement('span');
      el.className = 'ampm';
      el.textContent = ampm.value;
      nodes.unshift(el);
    }
    clockTime.replaceChildren(...nodes);
    clockDate.textContent = dateFmt.format(now);
  }

  function setClockOn(on) {
    clockEl.classList.toggle('off', !on);
  }

  setClock24(false);
  setInterval(drawClock, 1000);

  // ---------- Lively Wallpaper ----------
  // LivelyInfo.json의 "Arguments": "--system-nowplaying" 으로 켜진다.
  // data는 JSON 문자열이고, 재생 중인 게 없으면 null.

  window.livelyCurrentTrack = (data) => {
    hostSeen = true;
    let obj = null;
    try {
      obj = typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) {
      obj = null;
    }
    if (!obj || !obj.Title) {
      onHostPlayback(false); // 마지막 곡은 그대로 두고 어둡게만
      return;
    }
    let art = null;
    if (obj.Thumbnail) {
      art = obj.Thumbnail.startsWith('data:')
        ? obj.Thumbnail
        : `data:image/png;base64,${obj.Thumbnail}`;
    }
    onHostTrack({
      title: obj.Title,
      artist: obj.Artist || obj.AlbumArtist,
      album: obj.AlbumTitle,
      art,
    });
    onHostPlayback(true);
  };

  // LivelyProperties.json 설정값
  window.livelyPropertyListener = (name, val) => {
    hostSeen = true;
    if (name === 'artSize') setArtSize(val);
    if (name === 'hiRes') setHiRes(val);
    if (name === 'lyrics') setLyricsOn(val);
    if (name === 'clock') setClockOn(val);
    if (name === 'clock24') setClock24(val);
    if (name === 'hideDelay') setHideDelay(val);
  };

  // ---------- Wallpaper Engine ----------

  if (window.wallpaperRegisterMediaPropertiesListener) {
    hostSeen = true;
    let current = {};
    window.wallpaperRegisterMediaPropertiesListener((e) => {
      // 곡이 바뀌면 옛 곡 썸네일을 버린다 (새 썸네일은 따로 도착)
      const sameTrack = titleKey(e.title) === titleKey(current.title);
      current = { title: e.title, artist: e.artist || e.albumArtist, album: e.albumTitle, art: sameTrack ? current.art : null };
      onHostTrack(current);
    });
    window.wallpaperRegisterMediaThumbnailListener((e) => {
      current = { ...current, art: e.thumbnail };
      onHostTrack(current);
    });
    if (window.wallpaperRegisterMediaPlaybackListener) {
      window.wallpaperRegisterMediaPlaybackListener((e) => {
        onHostPlayback(e.state === window.wallpaperMediaIntegration.PLAYBACK_PLAYING);
      });
    }
  }

  window.wallpaperPropertyListener = {
    applyUserProperties(p) {
      if (p.artsize) setArtSize(p.artsize.value);
      if (p.hires) setHiRes(p.hires.value);
      if (p.lyrics) setLyricsOn(p.lyrics.value);
      if (p.clock) setClockOn(p.clock.value);
      if (p.clock24) setClock24(p.clock24.value);
      if (p.hidedelay) setHideDelay(p.hidedelay.value);
    },
  };

  // ---------- 테스트 모드 ----------
  // 일반 브라우저에서 열면(2초 동안 Lively/Wallpaper Engine 신호가 없으면) 예시 곡으로 그린다.
  // 주소 끝에 ?test 를 붙이면 바로 켜진다.
  // 버튼과 재생목록은 가짜 도우미로 동작한다 (진짜 Spotify는 건드리지 않음).

  // 실제 썸네일과 비슷하게 300px짜리 예시 앨범 아트를 그린다
  function makeTestArt(skyTop, skyBottom, field, ground) {
    const s = 300;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');

    let g = ctx.createLinearGradient(0, 0, 0, s * 0.6);
    g.addColorStop(0, skyTop);
    g.addColorStop(1, skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s * 0.6);

    ctx.fillStyle = field;
    ctx.fillRect(0, s * 0.55, s, s * 0.2);
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * s;
      const y = s * 0.5 + Math.random() * s * 0.25;
      ctx.fillRect(x, y, 1, 4 + Math.random() * 8);
    }

    g = ctx.createLinearGradient(0, s * 0.72, 0, s);
    g.addColorStop(0, ground);
    g.addColorStop(1, skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, s * 0.72, s, s * 0.28);

    // 걸어가는 사람 실루엣
    ctx.fillStyle = 'rgba(40, 30, 25, 0.9)';
    ctx.beginPath();
    ctx.arc(s * 0.36, s * 0.53, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(s * 0.345, s * 0.555, 10, 34);
    return c.toDataURL('image/jpeg', 0.9);
  }

  function startTestMode() {
    const tracks = [
      { title: '서쪽 하늘에 - 2025 New Ver.', artist: '테스트 아티스트', album: '예시 앨범',
        art: makeTestArt('#c4cccb', '#a9b0ad', '#8a6a3a', '#b8aea6') },
      { title: '아주 아주 긴 제목이 들어가면 어떻게 보이는지 확인하기 위한 예시 곡 이름 (Live at Somewhere)',
        artist: '두 번째 아티스트', album: '두 번째 앨범',
        art: makeTestArt('#1d2b4a', '#c0607a', '#2a2238', '#3a3050') },
      { title: 'Green Morning', artist: 'Sample Band', album: '',
        art: makeTestArt('#9fd0c8', '#e8efe0', '#4d7a3a', '#6b8f55') },
      { title: '새벽 산책', artist: '예시 가수', album: '',
        art: makeTestArt('#2c3440', '#8a9bb0', '#3d4a3a', '#55606a') },
      { title: 'Golden Hour', artist: 'Sample Duo', album: '',
        art: makeTestArt('#f2b56b', '#f7dfb0', '#a0582a', '#c08a5a') },
    ];
    const playlists = [
      { name: '좋아요 표시한 곡', total: 321, uri: 'test:liked', liked: true },
      { name: '비 오는 날 듣는 노래', owner: '나', total: 42, uri: 'test:pl:0', image: tracks[0].art },
      { name: '드라이브', owner: '나', total: 118, uri: 'test:pl:1', image: tracks[4].art },
      { name: '집중할 때', owner: 'Spotify', total: 75, uri: 'test:pl:2', image: tracks[3].art },
    ];
    const n = tracks.length;
    const DUR = 200000; // 예시 곡은 모두 3:20
    const item = (k) => {
      const t = tracks[k % n];
      return { name: t.title, artists: t.artist, album: t.album, image: t.art, art: t.art, uri: `spotify:track:test${k % n}`, duration_ms: DUR };
    };
    let i = 0;
    let playing = true;
    let repeat = 'off';
    let shuffle = false;
    let volume = 70;
    let context = 'test:pl:0';
    const liked = new Set(['spotify:track:test1']);
    let pos0 = 0;
    let posAt = Date.now();
    const posNow = () => (playing ? Math.min(DUR, pos0 + Date.now() - posAt) : pos0);
    const setPos = (p) => {
      pos0 = p;
      posAt = Date.now();
    };
    const go = (k) => {
      i = (k + n) % n;
      setPos(0);
      showTrack(tracks[i]);
    };

    fakeHelper = async (path, body) => {
      if (path === '/api/status') return { ready: true };
      if (path === '/api/player') {
        return {
          active: true, is_playing: playing, context_uri: context, track: item(i), repeat, shuffle,
          progress_ms: posNow(), duration_ms: DUR, volume, supports_volume: true,
        };
      }
      if (path.startsWith('/api/search/prompt')) {
        await new Promise((r) => setTimeout(r, 1500)); // 입력하는 시간 흉내
        return { query: '테스트' };
      }
      if (path.startsWith('/api/liked')) {
        const uris = new URLSearchParams(path.split('?')[1]).get('uris').split(',');
        return { liked: Object.fromEntries(uris.map((u) => [u, liked.has(u)])) };
      }
      if (path === '/api/like') {
        if (body.on) liked.add(body.uri);
        else liked.delete(body.uri);
        return { ok: true };
      }
      if (path.startsWith('/api/lyrics')) {
        const name = new URLSearchParams(path.split('?')[1]).get('track');
        if (name === tracks[3].title) return { lines: null }; // 가사 없는 곡
        return { lines: Array.from({ length: 40 }, (_, k) => [k * 4000 + 2000, k % 9 === 8 ? '' : `${name} 가사 ${k + 1}번째 줄${k % 3 ? '' : ' — 조금 더 길게 써서 두 줄로 넘어가는지 보기'}`]) };
      }
      if (path.startsWith('/api/search')) {
        return tracks.map((t, k) => ({ ...item(k), album_uri: `test:album:${k}` }));
      }
      if (path === '/api/queue') return { current: item(i), queue: Array.from({ length: 10 }, (_, k) => item(i + k + 1)) };
      if (path === '/api/playlists') return playlists;
      if (path === '/api/control') {
        if (body.action === 'next') go(i + 1);
        else if (body.action === 'previous') go(i - 1);
        else if (body.action === 'repeat') repeat = body.state;
        else if (body.action === 'shuffle') shuffle = body.state;
        else if (body.action === 'volume') volume = body.volume_percent;
        else if (body.action === 'queue') return { ok: true };
        else if (body.action === 'seek') setPos(body.position_ms);
        else {
          setPos(posNow());
          playing = body.action === 'play';
        }
      }
      if (path === '/api/play') {
        if (body.skip) {
          go(i + body.skip);
        } else {
          context = body.context_uri;
          go(body.offset_uri ? Number(body.offset_uri.replace(/\D/g, '')) : 0);
        }
        playing = true;
      }
      return { ok: true };
    };
    go(0);
  }

  // 도우미 확인은 바로 시작한다 (확인 전에 온 Windows 정보는 다른 앱 것일 수 있어서 보류)
  const forceTest = /[?&]test\b/.test(location.search);
  if (forceTest) startTestMode();
  // 도우미를 아직 못 찾았으면 1초마다, 찾은 뒤에는 5초마다 확인 (컴퓨터를 막 켰을 때 빨리 연결되게)
  // 탭 버전은 곡이 바뀌었다는 Windows 신호가 없어서 재생 중엔 2초(멈췄으면 4초)마다 묻고, 화면이 꺼져 있으면 묻지 않는다
  async function helperLoop() {
    if (!(webMode && document.hidden)) await checkHelper();
    setTimeout(helperLoop, !helperReady ? 1000 : webMode ? (isPlaying ? 2000 : 4000) : 5000);
  }
  helperLoop();
  if (webMode) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkHelper(); // 화면을 다시 켜면 바로 맞춤
    });
  }
  if (!forceTest && !webMode) {
    setTimeout(() => {
      if (!hostSeen && !helperReady) startTestMode();
    }, 2000);
  }
})();
