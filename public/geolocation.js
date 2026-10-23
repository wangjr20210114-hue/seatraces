/* 获取设备位置，统一原生定位与浏览器定位结果。 */

export function locationMessage(code, harmony = false) {
  if (code === 1 || code === "permission")
    return "未获得定位权限，可在系统设置允许，或手动选出发城市";
  if (code === "disabled") return "系统定位服务未开启，请开启后重试";
  if (code === 3 || code === "timeout")
    return harmony
      ? "暂未收到位置；模拟器请先在 GPS 面板发送坐标，也可以手动选城市"
      : "定位超时，请重试或手动选出发城市";
  return harmony
    ? "暂无定位信号；模拟器请先在 GPS 面板发送坐标，或手动选城市"
    : "暂时无法定位，请重试或手动选出发城市";
}

export async function currentPosition({
  native = globalThis.SeaTracesLocation,
  geolocation = globalThis.navigator?.geolocation,
  detailed = false,
  passive = false,
} = {}) {
  if (native?.requestLocation) {
    if (passive && !native.authorizedLocation) throw Error("请先开启定位");
    const result = JSON.parse(
      await (passive ? native.authorizedLocation() : native.requestLocation()),
    );
    if (!result.ok)
      throw Object.assign(Error(locationMessage(result.code, true)), {
        code: result.code,
      });
    if (
      !Number.isFinite(result.lat) ||
      !Number.isFinite(result.lng) ||
      Math.abs(result.lat) > 90 ||
      Math.abs(result.lng) > 180
    )
      throw Error("设备返回的位置无效，请重试");
    return {
      lat: result.lat,
      lng: result.lng,
      ...(detailed ? { accuracy: result.accuracy, at: result.at } : {}),
    };
  }
  if (
    passive &&
    (await globalThis.navigator?.permissions?.query({ name: "geolocation" }))
      ?.state !== "granted"
  )
    throw Error("请先开启定位");
  if (!geolocation) throw Error("此设备暂不支持定位，请手动选出发城市");
  return new Promise((resolve, reject) =>
    geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          ...(detailed ? { accuracy: p.coords.accuracy, at: p.timestamp } : {}),
        }),
      (e) =>
        reject(
          Object.assign(
            Error(
              locationMessage(
                e.code,
                /HarmonyOS|OpenHarmony/i.test(
                  globalThis.navigator?.userAgent || "",
                ),
              ),
            ),
            { code: e.code },
          ),
        ),
      {
        timeout: 15000,
        maximumAge: detailed ? 0 : 60000,
        enableHighAccuracy: detailed,
      },
    ),
  );
}
