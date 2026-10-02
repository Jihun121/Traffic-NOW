# Traffic NOW - 실시간 교통정보 분석 대시보드

부산광역시 및 국토교통부 국가교통정보센터(ITS) API를 결합하여 실시간 교통 흐름을 분석하고 시각화하는 고성능 웹 서비스입니다.

---

## 🚀 비즈니스 로직 파이프라인

본 서비스는 원시 교통 데이터를 다음과 같은 6단계 파이프라인으로 정제·분석하여 제공합니다:

```
[도로 평균속도 수집]
       ↓
[도로별 속도 기준 분류] (도시고속/간선대로/일반도로 차등 기준)
       ↓
[원활 / 서행 / 정체 3단계 판정]
       ↓
[부산 전체 통계 산출] (평균속도, 혼잡도 지수, 상태별 비율)
       ↓
[실시간 정체 TOP 10 랭킹 산출]
       ↓
[프론트엔드 실시간 대시보드 시각화]
```

---

## 🔑 환경 변수 및 API 키 설정 (Cloudflare)

Cloudflare Pages 및 Workers에 아래 두 개의 API 키를 등록합니다:

1. **`BUSAN_TRAFFIC_API_KEY`**:
   - 부산광역시_링크소통정보 공공데이터 API 인증키
   - 용도: 부산 시내 주요 간선도로 및 도시고속도로 1,000+개 링크 속도 수집
2. **`ITS_API_KEY`**:
   - 국토교통부 국가교통정보센터(ITS) 오픈 API 인증키
   - 용도: 부산 진출입 고속도로 및 광역 연계 도로 소통/돌발 정보 수집
3. **`TRAFFIC_CACHE`**:
   - Cloudflare KV 네임스페이스 바인딩 (Pages 및 Collector Worker 양쪽에 동일하게 바인딩)

---

## 🛠 아키텍처 구성

- **프론트엔드**: Vanilla JS, Modern CSS (다크 테마 대시보드), HTML5
- **백엔드 (API)**: Cloudflare Pages Functions (`functions/api/traffic.js`)
  - KV 캐시 우선 제공 (응답 속도 10ms 이내)
  - KV 미존재 시 실시간 On-demand Fallback 수집 및 자동 캐싱
- **배경 수집기**: Cloudflare Workers (`traffic-collector`)
  - 10분 주기 Cron 트리거로 부산 API + ITS API 병렬 수집
  - 통계 및 정체 TOP 10 사전 연산 후 KV에 저장
