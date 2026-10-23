/* 查询火车和航班信息，整理出行候选项。 */

import { request } from "./http.mjs";
import { unavailable } from "./unavailable.mjs";

export async function trainSearch({ from, to, date }) {
  if (!process.env.JUHE_TRAIN_KEY)
    return unavailable(
      "聚合数据",
      "火车票接口尚未配置授权。本次没有实时车次、余票或票价结果。",
    );
  const body = new URLSearchParams({
    key: process.env.JUHE_TRAIN_KEY,
    search_type: "1",
    departure_station: from,
    arrival_station: to,
    date,
    enable_booking: "2",
  });
  const r = await request("Juhe", "https://apis.juhe.cn/fapigw/train/query", {
    method: "POST",
    body,
  });
  if (r.error_code !== 0)
    throw Object.assign(
      new Error("车次查询失败：" + (r.reason || "服务不可用")),
      { status: 502 },
    );
  return {
    status: "live",
    provider: "聚合数据",
    checkedAt: new Date().toISOString(),
    items: (r.result || []).slice(0, 50).map((x) => ({
      code: x.train_no,
      from: x.departure_station,
      to: x.arrival_station,
      departure: x.departure_time,
      arrival: x.arrival_time,
      duration: x.duration,
      prices: (x.prices || []).map((p) => ({
        seat: p.seat_name,
        price: p.price,
        currency: "CNY",
        remaining: p.num,
      })),
    })),
  };
}
let flightToken = null;
export async function flightSearch({ from, to, date }) {
  if (!process.env.AMADEUS_CLIENT_ID || !process.env.AMADEUS_CLIENT_SECRET)
    return unavailable(
      "Amadeus",
      "航班接口尚未配置授权。需要申请生产环境权限，测试环境不能代表实时票价。",
    );
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to))
    throw Object.assign(
      new Error("航班查询请输入三位机场/城市 IATA 代码，例如 SHA、SIN。"),
      { status: 400 },
    );
  const base =
    process.env.AMADEUS_PRODUCTION === "true"
      ? "https://api.amadeus.com"
      : "https://test.api.amadeus.com";
  if (!flightToken || flightToken.until < Date.now()) {
    const t = await request("Amadeus", base + "/v1/security/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.AMADEUS_CLIENT_ID,
        client_secret: process.env.AMADEUS_CLIENT_SECRET,
      }),
    });
    flightToken = {
      value: t.access_token,
      until: Date.now() + ((t.expires_in || 1800) - 60) * 1000,
    };
  }
  const r = await request(
    "Amadeus",
    base +
      "/v2/shopping/flight-offers?" +
      new URLSearchParams({
        originLocationCode: from,
        destinationLocationCode: to,
        departureDate: date,
        adults: "1",
        currencyCode: "CNY",
        max: "10",
      }),
    { headers: { Authorization: "Bearer " + flightToken.value } },
  );
  return {
    status: process.env.AMADEUS_PRODUCTION === "true" ? "live" : "sandbox",
    provider: "Amadeus",
    checkedAt: new Date().toISOString(),
    message: "覆盖范围取决于供应商；报价可能变化，未创建订单。",
    items: (r.data || []).map((x) => ({
      code: x.itineraries[0].segments
        .map((s) => s.carrierCode + s.number)
        .join(" → "),
      from,
      to,
      departure: x.itineraries[0].segments[0].departure.at,
      arrival: x.itineraries[0].segments.at(-1).arrival.at,
      duration: x.itineraries[0].duration,
      prices: [
        {
          seat: "成人总价",
          price: x.price.grandTotal,
          currency: x.price.currency,
        },
      ],
    })),
  };
}
