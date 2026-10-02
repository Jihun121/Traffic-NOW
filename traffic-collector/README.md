# Traffic-NOW Background Collector Worker

실시간 부산시 교통 데이터와 국토부 ITS 데이터를 백그라운드에서 주기적으로 수집하고 정제·분석하여 Cloudflare KV에 적재하는 Worker입니다.

---

## ⚙️ Cloudflare Worker 설정

1. **KV Namespace 바인딩**:
   - Binding 이름: `TRAFFIC_CACHE`
   - Pages 프로젝트의 KV 바인딩과 동일한 네임스페이스를 연결합니다.
2. **Secrets (환경 변수)**:
   - `BUSAN_TRAFFIC_API_KEY`: 부산광역시 링크소통정보 API 인증키
   - `ITS_API_KEY`: 국토교통부 국가교통정보센터(ITS) API 인증키

---

## ⏱️ 동작 방식

- **Cron 트리거**: `*/10 * * * *` (매 10분 주기 자동 실행)
- **수집 및 분석**:
  1. 부산시 링크소통정보 API 페이징 수집 (1,000+건 링크)
  2. 국토교통부 ITS 부산권역 고속도로/연계도로 수집
  3. 도로 위계별 속도 기준에 따른 `원활 / 서행 / 정체` 상태 판정
  4. 부산 전체 통계 (평균속도, 혼잡도 지수, 원활/서행/정체 비율) 사전 계산
  5. 정체 TOP 10 랭킹 사전 계산
- **저장소 적재**:
  - `traffic:busan:latest` 키에 분석 완료된 종합 스냅샷을 저장 (TTL: 2시간)
