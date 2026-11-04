// 홈 화면에 추가했을 때 앱처럼 열리게 하는 서비스 워커.
// 늘 인터넷에서 새로 받고, 인터넷이 안 될 때만 마지막으로 받은 파일을 쓴다 (고친 게 바로 반영되게).
const CACHE = 'now-playing';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Spotify·가사 요청은 건드리지 않음
  // 페이지(index.html)는 GitHub가 10분 동안 캐시해도 되게 보내서, 바뀌었는지 서버에 꼭 물어본다.
  // 나머지 파일은 주소에 ?v=가 붙어 있어서 바뀌면 주소도 바뀜
  const req = e.request.mode === 'navigate' ? fetch(e.request.url, { cache: 'no-cache' }) : fetch(e.request);
  e.respondWith(
    req
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
