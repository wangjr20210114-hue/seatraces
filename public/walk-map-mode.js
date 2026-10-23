/* 设置 CityWalk 页面使用的地图模式。 */

if (new URLSearchParams(location.search).get("walk") === "1")
  document.body.classList.add("walk-edit");
