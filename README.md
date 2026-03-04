⏺ 구동 방법

사전 준비 — Python 패키지 설치 (최초 1회)

pip3 install requests pandas python-dotenv
                                                                                                                                                                     
---
터미널 1 — 백엔드 서버 시작

cd /Users/linrise/IdeaProjects/dashboard/server
node server.js

정상 시작 시 출력:
╔══════════════════════════════════════════╗
║  SENTINEL // CONFLICT MONITOR — BACKEND  ║
║  http://localhost:3001                   ║
╚══════════════════════════════════════════╝
[OpenSky] 143 aircraft  (12 military, 131 civilian)
[FIRMS] 38 fire hotspots

  ---
터미널 2 — 프론트엔드 시작

cd /Users/linrise/IdeaProjects/dashboard
npm run dev

브라우저에서 열기: http://localhost:5173

  ---
터미널 3 (선택) — Python 데이터 확인

cd /Users/linrise/IdeaProjects/dashboard/server

# 현재 데이터 1회 출력
python3 fetch_opensky.py

# 군용기만 필터
python3 fetch_opensky.py --military-only

# 30초마다 반복 갱신
python3 fetch_opensky.py --loop 30

# CSV 저장
python3 fetch_opensky.py --csv flights.csv

  ---
전체 구동 확인 체크리스트

┌──────────────┬─────────────────────────────────────────────────────────────────────┐
│     항목     │                              확인 방법                              │
├──────────────┼─────────────────────────────────────────────────────────────────────┤
│ 백엔드 정상  │ 브라우저에서 http://localhost:3001/api/health 접속 → JSON 응답 확인 │
├──────────────┼─────────────────────────────────────────────────────────────────────┤
│ OpenSky 연결 │ 터미널 1에서 [OpenSky] N aircraft 로그 확인                         │
├──────────────┼─────────────────────────────────────────────────────────────────────┤
│ FIRMS 연결   │ 터미널 1에서 [FIRMS] N fire hotspots 로그 확인                      │
├──────────────┼─────────────────────────────────────────────────────────────────────┤
│ 프론트 연결  │ 대시보드 좌측 상단 뱃지가 MOCK → LIVE 로 바뀌면 성공                │
└──────────────┴─────────────────────────────────────────────────────────────────────┘

  ---
업데이트 주기

┌──────────────────────────┬────────┐
│          데이터          │  주기  │
├──────────────────────────┼────────┤
│ 항공기 위치 (OpenSky)    │ 15초   │
├──────────────────────────┼────────┤
│ 화재 위성 데이터 (FIRMS) │ 5분    │
├──────────────────────────┼────────┤
│ OSINT 이벤트 (Telegram)  │ 실시간 │
└──────────────────────────┴────────┘

  ---
Telegram OSINT 처음 로그인할 때

# 서버 최초 실행 시 — 아래 프롬프트가 순서대로 나타남
📱 Telegram phone number (with country code): +821012345678
📨 OTP code from Telegram: 12345

# 로그인 성공 후 세션 문자열이 출력됨 → server/.env 에 저장
TELEGRAM_SESSION=1BQANOTEu...

세션을 .env에 저장하면 다음 실행부터는 로그인 없이 자동 연결됩니다.# mesafe-dashboard
