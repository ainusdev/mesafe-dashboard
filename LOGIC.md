# MESAFE — 동작 로직 정리 (설계 기준)

---

## 백엔드 시작 시 초기화

서버가 시작되면 공항·화점·비행 정보를 **모두 동시에** API로 요청하고 CSV로 저장한다.

```
서버 시작
  → fetchAirports()  → airports_<ts>.csv
  → fetchFIRMS()     → fires_<ts>.csv      + Firestore(fire_hotspots)
  → fetchAircraft()  → aircraft_<ts>.csv   + Firestore(aircraft_states)
```

이후 주기적으로 반복 (jitter 스케줄링):
- 비행 정보: `AIRCRAFT_INTERVAL_MS` + random(0, base × `INTERVAL_JITTER_MULTIPLIER`) → csv 저장 + Firestore 저장 + **이전 csv 삭제 (최신 1개만 유지)**
- 화점 정보: `FIRMS_INTERVAL_MS` + jitter → csv 저장 + Firestore 저장 + **24시간 초과 오래된 파일 삭제**
- 공항 정보: 주기 반복 없음 (시작 시 1회, 이후 클라이언트 요청 기준)

비행 API: OpenSky REST 우선 → 실패(429/timeout) 시 `airplanes.live` 자동 폴백

### CSV 파일 관리 규칙

| 데이터 | 보관 규칙 |
|---|---|
| 비행(aircraft) | 최신 1개만 유지, 나머지 삭제 |
| 화점(fires) | 최초 파일 기준 24시간 초과 시 해당 파일 삭제 |
| 공항(airports) | 단일 파일 덮어쓰기 (변경 드묾) |

---

## 프론트엔드 초기화 시퀀스

브라우저에서 서비스가 최초 로드되면:

```
1. localStorage 정리
   → 'mesafe_region' 키를 제외한 모든 항목 삭제

2. 백엔드에 초기화 요청 (data:init 이벤트)
   → airports:update 수신
   → aircraft:update 수신
   → fires:update 수신
```

---

## 백엔드 data:init 처리 흐름

클라이언트로부터 `data:init` 수신 시:

```
CSV 존재?
  YES → CSV에서 읽어 즉시 반환
  NO  → API fetch 실행 → CSV 저장 → 저장된 CSV에서 읽어 반환
```

세 데이터 모두 동일한 규칙 적용. CSV가 없는 상황은 서버 최초 기동 직후이거나
파일이 삭제된 경우이므로, **지체 없이 fetch → 저장 → 반환** 순서로 처리.

---

## Socket.io 이벤트

### 클라이언트 → 서버
| 이벤트 | 동작 |
|---|---|
| `data:init` | airports + aircraft + fires CSV 반환 요청 |

### 서버 → 클라이언트
| 이벤트 | 시점 |
|---|---|
| `airports:update` | data:init 응답 |
| `aircraft:update` | data:init 응답 + 주기 브로드캐스트(100s) |
| `fires:update` | data:init 응답 + 주기 브로드캐스트(300s) |

---


## 프론트엔드 렌더링 구조

### 모드
| 모드 | 설명 |
|---|---|
| `live` | 백엔드 데이터만 사용. mock 데이터는 절대 표시하지 않음 |
| `mock` (IDLE) | 지도 비어있음 |
| `mock` (RUNNING) | 시뮬레이션 엔진 활성 (10s 틱) |

### 항공기 Physics Animation Loop
매 프레임(requestAnimationFrame) 실행. 백엔드 업데이트 사이를 dead reckoning으로 채움.

**Heading — 감쇠 스프링 (ζ≈0.8):**
```
headingRate = headingRate * exp(-1.6 * dt) + diff * 1.0 * dt
heading += headingRate * dt
```

**Speed — 비대칭 지수 감쇠:**
```
tau = 가속 2s / 감속 4s
currentSpeed += (target - current) * (1 - exp(-dt/tau))
```

**Position 적분:**
```
dist = currentSpeed * dt   (단위: deg/s)
lon += sin(heading_rad) * dist
lat += cos(heading_rad) * dist
```

live 모드: 신규 항공기만 GPS 위치로 스냅, 기존 항공기는 dead reckoning 유지
mock 모드: 10s 틱이 targetHeading만 갱신, position은 physics loop 전담

### Mock Engine (10s 틱)
- `tickAircraft()`: targetHeading만 갱신 (중심 2.5° 초과 시 중심 방향, 이내일 때 랜덤 편향)
- `tickFires()`: brightness 소폭 변동 + 1~3개 신규 핫스팟 추가, 최대 1000개 캡

---

## Mapbox 레이어

```
aircraft-source
  ├── aircraft-layer        SVG 아이콘 + 콜사인 텍스트 (아래)
  └── flag-layer            flagcdn.com PNG, 아이콘 위 표시

fire-source
  ├── fire-heat-layer       heatmap (zoom 4~9)
  └── fire-circle-layer     circle

airport-source
  ├── airport-circle-layer       large_airport, 기본 표시
  ├── airport-label-layer        large_airport, minzoom 6
  ├── airport-other-circle-layer medium/small, 기본 숨김
  └── airport-other-label-layer  medium/small, minzoom 8, 기본 숨김
```

**Mapbox 표현식 주의:** `['get', 'brightness']`는 타입 미지정 → 항상 `['to-number', ['get', 'brightness'], 0]`으로 감쌀 것.

---

## 국기 이미지
`COUNTRY_CODE` 맵: 국가명(ICAO 공식명 포함) → ISO alpha-2

`preloadAllFlags(map)`: `map.on('load')` 시점에 COUNTRY_CODE 전체 고유 ISO 코드 (~75개)를 **병렬로** `map.loadImage()` 호출 → 항공기 데이터 도착 전에 모든 국기 준비 완료.
- `_flagRequested` Set으로 중복 방지
- `flagcdn.com/20x15/{code}.png` → `map.addImage('flag-{code}', img)`
- flag-layer `icon-image: ['get', 'flagKey']`

---

## 군용기 판별 (백엔드)
1. 콜사인 prefix 매칭 (EAGLE, VIPER, REACH 등)
2. ICAO 24비트 hex 범위 매칭 (미 공군, 이스라엘 공군, 사우디 공군 등)

---

## Firestore 컬렉션
| 컬렉션 | doc ID | 갱신 방식 |
|---|---|---|
| `aircraft_states` | icao24 | 매 주기 덮어쓰기 |
| `fire_hotspots` | `{date}-{time}-{lat}-{lon}` | 동일 위성 패스 중복 방지 |

---

## localStorage
| 키 | 보관 여부 |
|---|---|
| `mesafe_region` | 유지 |
| 그 외 모든 키 | **서비스 로드 시 삭제** |
