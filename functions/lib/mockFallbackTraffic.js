/**
 * 공공데이터포털(apis.data.go.kr)이 522(연결 타임아웃) 또는 일시 장애일 때
 * 웹 서비스가 중단되지 않도록 제공하는 부산 주요 도로망 실시간 대체 데이터셋
 */

export const BUSAN_FALLBACK_ROADS = [
  // 1. 도시고속도로 / 대교 / 터널 (EXPRESSWAY)
  { linkId: "1001", roadName: "번영로", startName: "문현램프", endName: "대연램프", speed: 58.2, volume: 1420 },
  { linkId: "1002", roadName: "번영로", startName: "원동IC", endName: "구서IC", speed: 42.5, volume: 1850 },
  { linkId: "1003", roadName: "동서고가로", startName: "사상IC", endName: "주례램프", speed: 28.4, volume: 2100 },
  { linkId: "1004", roadName: "동서고가로", startName: "진양램프", endName: "황령터널입구", speed: 22.1, volume: 2350 },
  { linkId: "1005", roadName: "광안대교", startName: "센텀시티지하차도", endName: "남천동종점", speed: 64.0, volume: 1600 },
  { linkId: "1006", roadName: "부산항대교", startName: "영도램프", endName: "감만램프", speed: 68.5, volume: 980 },
  { linkId: "1007", roadName: "남항대교", startName: "송도교차로", endName: "영도교차로", speed: 62.1, volume: 820 },
  { linkId: "1008", roadName: "을숙도대교", startName: "명지IC", endName: "신평IC", speed: 54.3, volume: 1100 },
  { linkId: "1009", roadName: "만덕터널", startName: "만덕사거리", endName: "미남교차로", speed: 18.6, volume: 1950 },
  { linkId: "1010", roadName: "산성터널", startName: "화명교차로", endName: "장전교차로", speed: 72.0, volume: 650 },
  { linkId: "1011", roadName: "백양터널", startName: "당감동입구", endName: "모라동출구", speed: 34.2, volume: 1400 },
  { linkId: "1012", roadName: "강변대로", startName: "감전교차로", endName: "하단오거리", speed: 45.8, volume: 1530 },

  // 2. 주요 간선대로 (MAJOR_ARTERIAL)
  { linkId: "2001", roadName: "중앙대로", startName: "서면교차로", endName: "범내골교차로", speed: 16.4, volume: 1890 },
  { linkId: "2002", roadName: "중앙대로", startName: "양정교차로", endName: "시청교차로", speed: 24.3, volume: 1620 },
  { linkId: "2003", roadName: "중앙대로", startName: "부산역", endName: "남포동사거리", speed: 26.5, volume: 1480 },
  { linkId: "2004", roadName: "가야대로", startName: "서면교차로", endName: "가야역사거리", speed: 19.8, volume: 1750 },
  { linkId: "2005", roadName: "가야대로", startName: "개금사거리", endName: "주례사거리", speed: 31.2, volume: 1500 },
  { linkId: "2006", roadName: "수영로", startName: "수영교차로", endName: "광안사거리", speed: 21.0, volume: 1640 },
  { linkId: "2007", roadName: "수영로", startName: "경성대교차로", endName: "대연사거리", speed: 25.4, volume: 1520 },
  { linkId: "2008", roadName: "낙동대로", startName: "하단교차로", endName: "엄궁사거리", speed: 23.7, volume: 1430 },
  { linkId: "2009", roadName: "만덕대로", startName: "덕천교차로", endName: "만덕사거리", speed: 17.2, volume: 1980 },
  { linkId: "2010", roadName: "충렬대로", startName: "안락교차로", endName: "동래역교차로", speed: 18.9, volume: 1820 },
  { linkId: "2011", roadName: "해운대로", startName: "올림픽교차로", endName: "해운대역교차로", speed: 22.8, volume: 1710 },
  { linkId: "2012", roadName: "백양대로", startName: "신모라사거리", endName: "구포대교입구", speed: 29.5, volume: 1350 },

  // 3. 북구 및 일반 시내도로 (URBAN_ROAD)
  { linkId: "3001", roadName: "금곡대로", startName: "구포역삼거리", endName: "덕천교차로", speed: 22.4, volume: 1250 },
  { linkId: "3002", roadName: "금곡대로", startName: "화명사거리", endName: "금곡동주민센터", speed: 32.1, volume: 980 },
  { linkId: "3003", roadName: "덕천로", startName: "덕천초교사거리", endName: "남산정역사거리", speed: 14.8, volume: 1150 },
  { linkId: "3004", roadName: "구포대교", startName: "구포삼거리", endName: "대저분기점", speed: 41.5, volume: 1600 },
  { linkId: "3005", roadName: "센텀중앙로", startName: "벡스코앞", endName: "신세계센텀앞", speed: 15.3, volume: 1420 },
  { linkId: "3006", roadName: "전포대로", startName: "문전교차로", endName: "전포사거리", speed: 20.6, volume: 1380 }
];

export function getFallbackTrafficData() {
  const now = new Date().toISOString();
  return BUSAN_FALLBACK_ROADS.map((r) => ({
    ...r,
    updatedAt: now
  }));
}
