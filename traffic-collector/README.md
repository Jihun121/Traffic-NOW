# Traffic-NOW background collector

Traffic-NOW의 사용자 요청과 부산 공공데이터 API 호출을 분리합니다.

## Cloudflare 설정

Collector Worker에 다음을 연결합니다.

- KV namespace: binding `TRAFFIC_CACHE`
- Secret: `BUSAN_TRAFFIC_API_KEY`

Pages 프로젝트에도 같은 KV namespace를 `TRAFFIC_CACHE`라는 이름으로 바인딩해야 합니다.

Collector는 30분마다 부산광역시_링크소통정보를 수집해서
`traffic:busan:latest` 키에 저장합니다.

Pages Function은 이 스냅샷만 읽으므로 사용자가 페이지를 열 때 부산 API 응답을 기다리지 않습니다.
