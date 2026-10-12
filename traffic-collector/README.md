# Traffic-NOW Background Collector Worker

부산광역시 링크소통정보를 주 데이터로 수집하고, 국토부 ITS는 선택적 보조 데이터로 반영하는 Cloudflare Worker입니다. Free 플랜의 invocation별 CPU 제한을 고려해 수집·요약·정체 분석·브리핑·HISTORY 보관을 각각 분리했습니다.

## Cloudflare 설정

- Worker 이름: `traffic-now-worker`
- KV binding: `TRAFFIC_CACHE`
- Secrets:
  - `BUSAN_TRAFFIC_API_KEY` — 부산광역시 링크소통정보 API 인증키
  - `ITS_API_KEY` — 국토교통부 ITS API 인증키(선택 사항)

`traffic-collector/wrangler.json`의 Cron은 두 개입니다.

- `*/10 * * * *`: 부산 API를 1회당 최대 3페이지씩 수집합니다.
- `*/2 * * * *`: 후처리 작업이 있을 때 ITS 통합, 급격한 정체 기준 갱신, 브리핑, HISTORY 저장을 단계별로 처리합니다. 작업이 없으면 즉시 종료합니다.

## 저장 구조

- `traffic:busan:collector-state`: 페이지 수집 진행 상태
- `traffic:busan:postprocess-state`: 수집 완료 후 단계별 후처리 커서
- `traffic:busan:rows:v4:<cycleId>:<groupId>`: 수집한 페이지 묶음(10개 페이지 단위)
- `traffic:busan:rows:v4-summary:<cycleId>:<groupId>`: 해당 묶음의 작은 통계/TOP 10 요약
- `traffic:busan:latest-analysis`: 현재 활성 수집 사이클의 통계와 분석 결과
- `traffic:busan:its:latest`: 가장 최근 완료 사이클의 보조 ITS 데이터
- `traffic:busan:history:index` 및 `traffic:busan:history:<timestamp>`: 최근 14일의 HISTORY 인덱스와 요약. HISTORY는 행 전체를 중복 저장하지 않고 완료된 row-cycle을 참조합니다.

페이지 수집 중에는 이전 COMPLETE 사이클을 활성 데이터로 유지하고, 현재 사이클에서 완료된 페이지 묶음만 겹쳐 보여줍니다. 93페이지 전체를 수집한 뒤 활성 사이클을 교체하고 후처리를 별도 Cron으로 진행합니다.

급격한 정체 기준은 시간대별로 나뉘며, 도로 묶음 2개씩 처리해 재시작 시 이어갈 수 있습니다. 동일한 완성 스냅샷을 재시도해도 기준 표본과 감지 결과가 중복 반영되지 않도록 결과를 체크포인트와 함께 저장합니다.

## 배포

프로젝트 루트에서 실행합니다.

```powershell
npx wrangler@4.148.0 deploy --config traffic-collector/wrangler.json --secrets-file traffic-collector/.secrets.json
```

`.secrets.json`은 로컬 전용이며 Git에 커밋하지 마세요. 배포 후 Cloudflare Observability에서 `collector-progress`, `collector-cycle-shards-complete`, `collector-postprocess-*`, `collector-history-archive-success` 이벤트를 확인할 수 있습니다.
