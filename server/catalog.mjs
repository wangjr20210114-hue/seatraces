/* 导出地点目录服务，供现有调用入口使用。 */

export { catalogQuery, siteQuery } from "./contracts/catalog.mjs";
export { catalogRequest, resolvePlace } from "./services/catalog.mjs";
