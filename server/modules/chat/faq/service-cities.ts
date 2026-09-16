/**
 * 服务城市配置表（35 城 · 本业务实际可接单城市）
 *
 * 与官网品牌口径（覆盖全国 300+ 城市）区分：对外宣传用品牌口径，
 * 「您所在城市有没有服务」用本名单精确判断。调整名单只改此文件。
 */
export const SERVICE_CITIES: string[] = [
  '北京', '成都', '重庆', '长沙', '东莞', '大连', '佛山', '福州',
  '广州', '贵阳', '杭州', '合肥', '哈尔滨', '济南', '昆明', '兰州',
  '南京', '宁波', '南昌', '南宁', '青岛', '上海', '深圳', '苏州',
  '沈阳', '石家庄', '天津', '太原', '温州', '无锡', '武汉', '西安',
  '厦门', '郑州', '珠海',
];

/** 判断城市是否在服务名单内（去掉「市」后缀再匹配） */
export function hasCity(city: string): boolean {
  return SERVICE_CITIES.includes(city.replace(/市$/u, ''));
}

/** 从客户原话中提取服务城市（兼容「北京 / 北京市」写法） */
export function detectServiceCity(text: string): string | null {
  for (const city of SERVICE_CITIES) {
    if (text.includes(city) || text.includes(`${city}市`)) {
      return city;
    }
  }
  return null;
}
