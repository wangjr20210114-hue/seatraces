/* 读取外部服务配置并汇总可用状态。 */

export function providerStatus() {
  return {
    maps: process.env.AMAP_KEY ? "configured_unverified" : "not_configured",
    overseasMaps:
      process.env.OVERSEAS_MAP_PROVIDER === "google" &&
      process.env.GOOGLE_MAPS_SERVER_KEY
        ? "configured_unverified"
        : "not_configured",
    llm: process.env.DEEPSEEK_API_KEY
      ? "configured_unverified"
      : "not_configured",
    weather:process.env.AMAP_KEY?'configured_unverified':'not_configured',
    weatherAlerts:process.env.QWEATHER_API_HOST&&process.env.QWEATHER_API_KEY?'configured_unverified':'not_configured',
    train: process.env.JUHE_TRAIN_KEY
      ? "configured_unverified"
      : "not_configured",
    flight: process.env.AMADEUS_CLIENT_ID
      ? process.env.AMADEUS_PRODUCTION === "true"
        ? "configured_unverified"
        : "sandbox"
      : "not_configured",
  };
}
