/* 定义端到端测试用例和执行环境的覆盖关系。 */

import { readFileSync, readdirSync } from "node:fs";
const catalog = JSON.parse(
  readFileSync(new URL("./catalog.json", import.meta.url), "utf8"),
);
export const allCases = catalog.modules.flatMap((m) => m.cases);
export const browserIds = new Set();
for (const file of readdirSync(new URL("./specs/", import.meta.url))) {
  if (!file.endsWith(".spec.mjs") || file === "catalog.spec.mjs") continue;
  for (const m of readFileSync(
    new URL("./specs/" + file, import.meta.url),
    "utf8",
  ).matchAll(/check\(\s*['"]([A-Z][A-Z0-9]*-\d+)['"]/g))
    browserIds.add(m[1]);
}
export const coverage = {};
const expand = (prefix, range) =>
  range
    .split(/[,\s]+/)
    .filter(Boolean)
    .flatMap((part) => {
      const [a, b = a] = part.split("-").map(Number);
      return Array.from(
        { length: b - a + 1 },
        (_, i) => prefix + "-" + String(a + i).padStart(3, "0"),
      );
    });
function assign(prefix, range, value) {
  for (const id of expand(prefix, range)) {
    if (browserIds.has(id)) continue;
    if (coverage[id]) throw Error("Duplicate case coverage " + id);
    coverage[id] = { ...value };
  }
}
const N = (p, r, file, test, note) =>
  assign(p, r, {
    kind: "native",
    coverage: "partial",
    evidence: [{ file: file + ".test.mjs", prefix: test }],
    note,
  });
const B = (p, r, reason) =>
  assign(p, r, { kind: "blocked", coverage: "none", reason });

N(
  "AUTH",
  "6",
  "guest",
  "guest HTTP",
  "真实游客 HTTP 请求后核对用户、会话、路线与事件表均不增加。",
);
N(
  "AUTH",
  "8 12 18 20 24-28",
  "accounts",
  "PostgreSQL accounts:",
  "真实 PostgreSQL 账号隔离、重复账号、邮箱令牌一次性、密码重设与会话撤销；使用内存收件箱，未验证外部邮件投递或全部页面分支。",
);
N(
  "AUTH",
  "9 11 23",
  "catalog-boundaries",
  "AUTH boundary",
  "真实账号接口验证长度/字节/邮箱非法输入，数据库不采信客户端角色；邮件仅测试输入校验。",
);
N(
  "AUTH",
  "15",
  "admin-access",
  "06 shared account rate limit",
  "真实错误登录限流及应用/后台共享限流边界；浏览器等待文案与解限后再次登录另验收。",
);
N(
  "AUTH",
  "16",
  "catalog-boundaries",
  "AUTH redirect",
  "真实登录页站内 next 和外链拒绝；验证页面重定向约束。",
);
B(
  "AUTH",
  "19",
  "需要部署后的 HTTPS 域名与该环境登录会话，检查生产 Set-Cookie；本地 HTTP 不能证明生产 Secure 设置。",
);
N(
  "AUTH",
  "22",
  "accounts",
  "PostgreSQL accounts:",
  "内存收件箱验证邮箱绑定、验证链接及找回闭环；真实邮件送达、邮箱客户端点击仍需 SMTP 联调。",
);

N(
  "ME",
  "1 8 10",
  "personal-center",
  "guests rejected;",
  "真实接口核对概览和私有列表归属；页面布局及20项滚动交互另验收。",
);
N(
  "ME",
  "4 6-7",
  "accounts",
  "PostgreSQL accounts:",
  "账号资料保存、静态 PNG 上传、坏图拒绝及读取归属；超大/动画图片和昵称全部边界见补充检查。",
);
N(
  "ME",
  "11",
  "citywalk",
  "PostgreSQL CityWalk",
  "存储快照可编辑、重读，草稿失效拒绝；地图视觉另验收。",
);
N(
  "ME",
  "12-13",
  "personal-center",
  "removing own favorite",
  "收藏归属与删除只影响本人，帖子及其他用户收藏保留。",
);
N(
  "ME",
  "14-15",
  "social-style",
  "save/like/view same post",
  "浏览去重、清理及推荐证据撤销的数据库规则；二次确认页面另验收。",
);
N(
  "ME",
  "16-17",
  "personal-center",
  "report counts actual presence",
  "计划、完成、检测到访区分，空计划不生成到访；城市统计呈现另验收。",
);
N(
  "ME",
  "18-19",
  "personal-center",
  "preference edits",
  "偏好实际落库与乐观版本保护，长期记忆写入归属。",
);
N(
  "ME",
  "20-21",
  "personal-center",
  "password change",
  "真实修改密码、会话轮换与拒绝错误输入；前端输入反馈另验收。",
);
N(
  "ME",
  "22",
  "personal-center",
  "session revocation",
  "退出其他会话要求密码、保留当前会话；密码不写入日志。",
);
N(
  "ME",
  "23-26",
  "inbox",
  "MSG-02",
  "消息实际投递、收件人隔离与已读幂等；多页前端滚动及空状态另验收。",
);

B(
  "PLAN",
  "1",
  "需要浏览器/真机位置授权和有效定位输入；隔离套件没有设备 GPS，不能用伪造坐标冒充真实定位成功。",
);
N(
  "PLAN",
  "2",
  "journey-feedback",
  "native geolocation",
  "定位缺信号/拒绝的返回合同；真实设备按钮交互另验收。",
);
N(
  "PLAN",
  "3",
  "social-ui",
  "route adoption",
  "同国家城市别名归一、跨国家同名保持歧义；真实境外地点覆盖依赖云端库。",
);
N(
  "PLAN",
  "6-7 9-11",
  "journey",
  "five-city limit",
  "真实城市数、日期、包含首尾日与交通分配规则；完整浏览器日历交互另验收。",
);
N(
  "PLAN",
  "12 16 18",
  "map-workspace",
  "map scenes",
  "地图场景坐标、边界和视图参数协议；未启用真实高德 SDK，实际相机与动画需视觉验收。",
);
N(
  "PLAN",
  "13-14 35",
  "trip-presentation",
  "slow city jobs",
  "异步城市任务状态、重试、用户隔离与过期；等待动画和离页交互需网页验收。",
);
N(
  "PLAN",
  "15",
  "scenic-wishes",
  "large cities keep",
  "大城市分组保留所有来源 ID、小城市自适应分组。",
);
N(
  "PLAN",
  "17",
  "journey",
  "city areas preserve",
  "聚类编号唯一、景点锚点与数量保留。",
);
N(
  "PLAN",
  "19-20",
  "trip-presentation",
  "only outer scenic",
  "外层想去与真实子层级披露组件输出；真实图形位置另验收。",
);
N(
  "PLAN",
  "21",
  "journey-candidate-memory",
  "JM06",
  "真实资料按需请求与所有权，资料失败不编造值。",
);
N(
  "PLAN",
  "22",
  "journey",
  "missing and expired crowd",
  "过期/无来源客流不惩罚，偏好调节有效来源；列表排序视觉另验收。",
);
N(
  "PLAN",
  "23",
  "scenic-wishes",
  "a low-ranked wish",
  "低分想去与子景点想去保留到候选及详情。",
);
N(
  "PLAN",
  "24-26 36",
  "journey-candidate-memory",
  "JM02",
  "真实会话城市/片区归属与重复/未知选择拒绝；跨页状态呈现另验收。",
);
N(
  "PLAN",
  "27-28",
  "provider-boundaries",
  "DeepSeek receives",
  "模型输入有界、无 Key 不发请求；内部题库内容及降级页仍需完整问卷验收。",
);
N(
  "PLAN",
  "29",
  "social-style",
  "generated facts stay",
  "本次明确答案优先于长期画像、确认记忆。",
);
N(
  "PLAN",
  "30",
  "journey",
  "LLM cannot introduce",
  "模型不能引入候选外地点、重复 ID 或额外日期；生成落库另由闭环检查覆盖。",
);
N(
  "PLAN",
  "31",
  "time-budget",
  "pace changes",
  "跨城下午时间预算与节奏；不等于实时车次联调。",
);
N(
  "PLAN",
  "32",
  "time-budget",
  "nearby short visits",
  "近距离短游可超三站，距离与停留时间限制数量。",
);
N(
  "PLAN",
  "33",
  "product-events",
  "EVT02",
  "并发重放一次业务保存及一次原子事件；浏览器双击动作另验收。",
);
N(
  "PLAN",
  "34",
  "provider-boundaries",
  "budget refusal",
  "配额拒绝先于网络调用，不无限重试。",
);

N(
  "TRIP",
  "1",
  "map-presentation",
  "day fit",
  "当天路线范围计算与缩放图层逻辑，未验证真实 SDK 视图。",
);
N(
  "TRIP",
  "2",
  "trip-presentation",
  "overview keeps",
  "出发地、多城顺序和同城去重；真实底图另验收。",
);
N(
  "TRIP",
  "3",
  "time-budget",
  "illustrative curves",
  "示意曲线顺序与路况几何分离。",
);
N(
  "TRIP",
  "4",
  "navigation",
  "Amap walking",
  "高德跳转 URL、坐标与模式；实际设备安装唤起另验收。",
);
N(
  "TRIP",
  "5",
  "map-workspace",
  "map scenes",
  "大陆坐标转换一次、境外保留；故宫/纪念碑真实库位置需云端数据核对。",
);
N(
  "TRIP",
  "6",
  "frontend",
  "frontend survives",
  "静态资源可用及后端不可用状态；商业 SDK 故障视觉另验收。",
);
N(
  "TRIP",
  "7-10 12",
  "catalog-boundaries",
  "TRIP mutation",
  "真实行程版本修改、移除、冲突、受控候选和旧快照恢复。",
);
N(
  "TRIP",
  "11 27",
  "personal-center",
  "report counts actual presence",
  "完成与检测到访独立，不自动把计划点全算到访。",
);
N(
  "TRIP",
  "13",
  "social-drafts",
  "private source isolation",
  "行程分享生成私有草稿，归属和重放保护；分享按钮位置另验收。",
);
N(
  "TRIP",
  "14-15",
  "service-refinement",
  "unified dining",
  "统一餐饮及旧午晚餐选择兼容；前端距离唯一入口由界面检查补充。",
);
N(
  "TRIP",
  "16-17",
  "service-refinement",
  "five dispersed",
  "最多五家分散、去重换批与稀疏回退；缓冲动画需视觉验收。",
);
N(
  "TRIP",
  "18-20",
  "map-workspace",
  "meal overlays",
  "吃住叠层、选择地点、相机指令和上下文保留；抽屉动画/快速换批需浏览器补充。",
);
N(
  "TRIP",
  "21-26",
  "trip-services",
  "PostgreSQL nearby services:",
  "真实 PostgreSQL 推荐池、预览、版本化保存、移除、越权及过期池保护；不调用付费推荐。",
);
N(
  "TRIP",
  "28",
  "scenic-wishes",
  "location inference",
  "准确持续停留才形成信号，过路/过期/歧义样本不记到访。",
);

N(
  "WALK",
  "1-2",
  "catalog-boundaries",
  "WALK home",
  "真实首页轮播/暂停和路线按钮 DOM 合同；动画时长与观感另验收。",
);
N(
  "WALK",
  "3",
  "classic-citywalks",
  "researched classics",
  "五城十二条种子资料、站点与已保存核验路线完整性。",
);
N(
  "WALK",
  "4",
  "route-covers",
  "map cover fits",
  "路线包围范围及坐标转换；真实 SDK 视图另验收。",
);
N(
  "WALK",
  "5",
  "classic-citywalks",
  "200 concurrent catalogue",
  "200 次真实目录请求不触发外部重算。",
);
N(
  "WALK",
  "6 11 13",
  "walk-expansion",
  "nearby categories",
  "近邻650米范围、混合类别及访问条件；城市推荐链路另验收。",
);
N(
  "WALK",
  "8-9 15",
  "consumer-presentation",
  "walk labels",
  "安全有界地点简述、坐标及标签候选；触屏和遮挡需视觉验收。",
);
N(
  "WALK",
  "12 20",
  "walk-editor-preview",
  "CityWalk selection",
  "本地选点、近邻防抖及旧核验失效。",
);
N(
  "WALK",
  "14",
  "entity-identity",
  "server canonical IDs",
  "规范实体 ID 不二次靠名字半径错误合并。",
);
N(
  "WALK",
  "16",
  "citywalk",
  "CityWalk ordering",
  "起点变更保留集合并缩短交叉路线，不宣称全局最优。",
);
N(
  "WALK",
  "17-18 26",
  "catalog-boundaries",
  "WALK limits",
  "真实步行保存接口验证0/1/100/101站、标题及无效草稿，不调用高德。",
);
N(
  "WALK",
  "19 25",
  "classic-citywalks",
  "verified legs reuse",
  "路由供应商边界替身返回实际米数、缓存及失败仅预览；真实高德道路另验收。",
);
N(
  "WALK",
  "22-24",
  "classic-citywalks",
  "CityWalk distance boundaries",
  "9999/10000/10001/14999/15000/15001原始米数边界。",
);
N(
  "WALK",
  "27 29 31",
  "walk-expansion",
  "custom walk HTTP",
  "真实 HTTP 所有权、保存重放、冲突及距离限制。",
);
N(
  "WALK",
  "28 30",
  "citywalk",
  "PostgreSQL CityWalk",
  "真实路线快照编辑与过期草稿拒绝。",
);
N(
  "WALK",
  "32",
  "social-drafts",
  "private source isolation",
  "绑定本人路线的私有草稿和重放规则；CityWalk发帖按钮另验收。",
);
N(
  "WALK",
  "33",
  "social-drafts",
  "same trip supports",
  "已发布快照不随原私有路线删除/修改联动。",
);
N(
  "WALK",
  "34",
  "classic-citywalks",
  "CW-01",
  "下架与改名后重复种子不覆盖，直链返回404。",
);

B(
  "SOC",
  "1 15",
  "卡片视觉层级、小红书式阅读观感及图标审美需要人工视觉签收；不能由页面存在或截图生成自动判为合格。",
);
B(
  "SOC",
  "2",
  "需要真实高德静态底图服务和授权配置，验证实际快照、标注及署名；隔离网络不允许据合成底图判通过。",
);
N(
  "SOC",
  "3 16",
  "social-drafts",
  "format, ownership",
  "图片真实重编码与读取归属；首图视觉、九张排序和长图适配需页面验收。",
);
N(
  "SOC",
  "4",
  "route-covers",
  "provider failures",
  "封面失败、请求与图片大小有界且不泄露密钥；占位布局另验收。",
);
N(
  "SOC",
  "6-7",
  "social-community",
  "guest denied, pagination",
  "真实快照分页与游标跨范围拒绝。",
);
N(
  "SOC",
  "10",
  "social-community",
  "follow and unfollow",
  "关注/取消幂等、禁止自关注与关注流规则。",
);
N(
  "SOC",
  "14",
  "catalog-boundaries",
  "SOC reactions",
  "真实重复点赞/收藏/推荐请求，数量和最终状态不重复计数。",
);
N(
  "SOC",
  "17",
  "route-covers",
  "map cover fits",
  "分享路线实际坐标与包围范围；高德相机视觉另验收。",
);
N(
  "SOC",
  "18",
  "social-style",
  "adoption validates",
  "参考可见路线幂等，并要求新日期，不复制私有行程。",
);
N(
  "SOC",
  "20",
  "catalog-boundaries",
  "SOC comments",
  "空白、500/501字评论真实 HTTP 边界。",
);
N(
  "SOC",
  "23",
  "catalog-boundaries",
  "SOC share",
  "帖子分享链接只含站内帖子 ID，无私密会话参数。",
);
N(
  "SOC",
  "24",
  "social-drafts",
  "legacy publishing",
  "已发布帖子与私有稿读取分开。",
);
N(
  "SOC",
  "25-26",
  "social-community",
  "notifications and read",
  "关注/互动通知与已读的收件人隔离。",
);
N(
  "SOC",
  "27",
  "admin-moderation",
  "CM03",
  "隐藏阻止详情、评论、互动及重新分享。",
);
N(
  "SOC",
  "28",
  "social-community",
  "disabled authors",
  "作者停用阻止新旧公开写入口传播。",
);
N(
  "SOC",
  "29",
  "social-community",
  "dwell updates",
  "停留增量不能重放刷时长、受120秒日上限限制；浏览器后台计时另验收。",
);
N(
  "SOC",
  "30",
  "social-style",
  "feed ordering",
  "多维画像有限影响帖子与景点排序，不替代明确约束。",
);
N(
  "SOC",
  "31",
  "social-style",
  "own posts and comments",
  "自己的帖子和任意评论不自动成为喜爱证据。",
);

N(
  "POST",
  "4",
  "social-drafts",
  "private source isolation",
  "真实行程生成私有稿，隔离他人来源与幂等；页面入口位置另验收。",
);
N(
  "POST",
  "6",
  "social-drafts",
  "optimistic drafts",
  "草稿版本冲突不丢更新、拒绝外部媒体。",
);
N(
  "POST",
  "7",
  "social-drafts",
  "draft removal",
  "删除只限本人当前版本未发布稿；浏览器二次确认另验收。",
);
N(
  "POST",
  "8-11 13-14",
  "catalog-boundaries",
  "POST boundaries",
  "真实草稿数量、标题/正文/话题/媒体参数边界；客户端上传尺寸提示另验收。",
);
N(
  "POST",
  "12 16-17 19",
  "social-drafts",
  "format, ownership",
  "实际图片解码、WebP重编码、EXIF移除与私有读取；所有格式/排序UI另验收。",
);
N(
  "POST",
  "18",
  "catalog-boundaries",
  "POST offline",
  "真实浏览器断网保存错误与输入保留，恢复后可重试；上传大文件中断另验收。",
);
N(
  "POST",
  "20",
  "consumer-presentation",
  "travel-note writing",
  "生成文案只用路线事实、保留审阅、不虚构到访；真实模型文风需人工验收。",
);
N(
  "POST",
  "21 23",
  "social-drafts",
  "AI suggestion",
  "异步建议不改草稿版本或自动发布，仍受原稿版本约束。",
);
N(
  "POST",
  "22 24",
  "catalog-boundaries",
  "POST writing",
  "无路线事实不得编造经历，生成器只用给定行程事实；生成频率限制、模型失败后的页面保稿仍需专项验收。",
);
N(
  "POST",
  "26",
  "social-drafts",
  "20 simultaneous publish",
  "20次并发发布重试只产生同一帖子。",
);
N(
  "POST",
  "27",
  "social-drafts",
  "two published edits",
  "同帖编辑版本冲突，不重复发布新帖。",
);
N(
  "POST",
  "28",
  "admin-moderation",
  "CM03",
  "被隐藏帖子不能重新分享绕过治理；草稿编辑页提示另验收。",
);
N(
  "POST",
  "29",
  "social-drafts",
  "private source isolation",
  "公开快照去私有起点、日期答案和完整来源树；吃住字段投影另验收。",
);
N(
  "POST",
  "31",
  "route-covers",
  "cover authorization",
  "封面鉴权先于渲染及304条件响应，隔离其他用户。",
);
N(
  "POST",
  "32",
  "route-covers",
  "provider failures",
  "无配置及坏供应商结果拒绝且不泄露密钥；占位页面另验收。",
);

N(
  "AI",
  "1-2",
  "catalog-boundaries",
  "AI entry",
  "浏览器拖动边界、点击与键盘入口、减少动画媒体条件；手势观感另验收。",
);
N("AI", "8", "agent", "intent abstains", "否定、问询、引用/假设不能执行操作。");
N(
  "AI",
  "9 12 15-16",
  "agent",
  "dialogue accepts",
  "只接受当前问题合法选项和有依据参数，模糊值不能直接执行。",
);
N(
  "AI",
  "10-11 13",
  "agent-compound",
  "relative dates",
  "相对日期、跨月、矛盾与明确纠正；完整多轮UI另验收。",
);
N(
  "AI",
  "14",
  "agent",
  "uncertain request asks",
  "需求不明选项澄清、模型建议不执行及场外无工具；中途问答回原流程仍需人工对话验收。",
);
N(
  "AI",
  "17-18",
  "agent",
  "journey follows",
  "严格按原会话→目录→题目→生成接口顺序，并确认写入。",
);
N(
  "AI",
  "19-22 25 29 34-35 37-38 40-41 43",
  "agent",
  "PostgreSQL + real HTTP:",
  "真实数据库+HTTP确认、重放、版本冲突、归属、记忆与未知结果；旅行写端为受控替身，不冒充全真实旅行联调。",
);
N(
  "AI",
  "23",
  "agent",
  "eating and lodging:",
  "真实候选→预览→确认→版本化原API的工作流合同。",
);
N(
  "AI",
  "24",
  "agent-compound",
  "CityWalk agent checks",
  "AI必须先步行核验，不能放大已确认保存参数。",
);
N(
  "AI",
  "26",
  "agent",
  "bridge cannot invoke",
  "桥接不允许凭据端点/管理员/任意URL；密码交回页面的UI另验收。",
);
N(
  "AI",
  "27",
  "agent",
  "agent publication uses",
  "本人路线预览后使用页面相同发布接口，身份与版本受控。",
);
N(
  "AI",
  "28",
  "agent",
  "workflow guard binds",
  "能力/阶段/目标/参数和发布顺序约束；点赞评论完整UI另验收。",
);
N(
  "AI",
  "30-32",
  "agent",
  "software RAG never",
  "知识答案引用必须存在、禁止编造事实与来源；关键词降级不当作embedding质量评估。",
);
N(
  "AI",
  "33",
  "agent-compound",
  "compound travel wins",
  "复合旅行优先于长期记忆，明确本次需求不擅自存永久偏好。",
);
N(
  "AI",
  "36",
  "agent",
  "progress isolates",
  "请求进度归属与实际步骤；页面停止轮询另验收。",
);
N(
  "AI",
  "42",
  "provider-boundaries",
  "provider failures",
  "模型/地图失败不泄露请求体或Key、不自动重试；AI恢复文案另验收。",
);

N(
  "ADM",
  "5-6",
  "admin-access",
  "04 CSRF",
  "后台过期/撤销会话拒绝、独立30分钟状态；浏览器后退缓存另验收。",
);
N(
  "ADM",
  "7",
  "admin-permissions",
  "RBAC01",
  "只读分析只能读汇总，拒绝个人与导出。",
);
N(
  "ADM",
  "8",
  "admin-permissions",
  "RBAC03",
  "运营仅有授权名单，禁止个人轨迹、权限和任务。",
);
N(
  "ADM",
  "9-10",
  "admin-permissions",
  "RBAC04",
  "客服读权限、导出写拒绝、撤销后旧Cookie不可恢复。",
);
N(
  "ADM",
  "11-12",
  "admin-permissions",
  "RBAC02",
  "禁止自升权、保护管理员、10次并发修改仅一次成功并审计。",
);
N(
  "ADM",
  "14-16",
  "admin-user-insights",
  "USR03",
  "七类数据分页与精确用户归属；按钮页码边界另验收。",
);
N(
  "ADM",
  "17",
  "catalog-boundaries",
  "ADM navigation",
  "真实后台详情路由刷新与返回；并发迟到响应另验收。",
);
N(
  "ADM",
  "18",
  "operations",
  "ADM-03/04",
  "停用撤销会话并拒绝登录，恢复保留数据；页面取消确认另验收。",
);
N(
  "ADM",
  "20",
  "admin-actions",
  "20 repeated disable",
  "20次停用只一次状态迁移及审计。",
);
N(
  "ADM",
  "21",
  "admin-details",
  "confirmed revoke",
  "确认撤销原子且重放安全，保护管理员会话。",
);
N(
  "ADM",
  "22-23",
  "social-style",
  "style dimensions",
  "画像维度、未知值、衰减与显式偏好优先；后台表格另验收。",
);
N(
  "ADM",
  "24",
  "product-events",
  "EVT03",
  "同用户flow串起问卷、保存、完成真实事件。",
);
N(
  "ADM",
  "25",
  "admin-analytics",
  "analytics uses Beijing",
  "北京时间日期及31天范围校验。",
);

N(
  "AN",
  "1-2",
  "operations",
  "ADM-01/02",
  "总览用户状态与响应字段；实际24小时计数对比需更大时间样本。",
);
N(
  "AN",
  "3",
  "admin-permissions",
  "RBAC01",
  "委派分析角色不可读管理员health细节。",
);
N(
  "AN",
  "4 7",
  "admin-analytics",
  "AN01",
  "自然日补零、采集覆盖、后台/测试排除和北京时间边界。",
);
N(
  "AN",
  "5",
  "admin-analytics",
  "analytics uses Beijing",
  "未来/反向/超31天验证。",
);
N(
  "AN",
  "6 12",
  "admin-analytics",
  "AN04",
  "分群重叠、标记可恢复及汇总匿名化。",
);
N(
  "AN",
  "8-9",
  "admin-analytics",
  "AN02",
  "同flow有序漏斗和重放去重，不拼接其他用户。",
);
N(
  "AN",
  "10-11",
  "admin-analytics",
  "AN03",
  "精确目标日留存与尚未成熟的未知值。",
);
N(
  "AN",
  "13-14",
  "admin-journey-insights",
  "JI01",
  "保存快照检索、真实版本与私有定位裁剪。",
);
N(
  "AN",
  "15-17",
  "admin-journey-insights",
  "JI02",
  "版本差异、无历史不编造、步行核验与估算区分。",
);
N(
  "AN",
  "18-23",
  "admin-agent-insights",
  "AI traces link",
  "请求→工具→事务业务效果精确关联、失败语义与隐私投影；不提供后台代确认操作。",
);
N("AN", "24", "admin-archives", "AR04", "归档区间不当空数据，日汇总口径冻结。");

N(
  "LOG",
  "2-7",
  "admin-log-workbench",
  "combined filters",
  "真实精确过滤、状态、耗时、分页及排序；非法字段和范围另有纯函数断言。",
);
N(
  "LOG",
  "8-10 19",
  "catalog-boundaries",
  "LOG controls",
  "真实后台筛选、列选择、重置与URL状态；导出只采用已提交筛选合同另验收。",
);
N(
  "LOG",
  "11",
  "admin-details",
  "admin account/session/log",
  "日志详情安全摘要与访问审计；详情布局另验收。",
);
N(
  "LOG",
  "12-14",
  "admin-log-workbench",
  "views require",
  "视图持久偏好、字段范围及默认条件，实际数据库验证。",
);
N(
  "LOG",
  "15 17",
  "admin-log-workbench",
  "concurrent edits",
  "视图乐观并发、重名、所有者隔离。",
);
N(
  "LOG",
  "16",
  "admin-log-workbench",
  "audit failure rolls",
  "删除失败回滚、成功只删偏好不删日志。",
);
N(
  "LOG",
  "20 28",
  "operations",
  "ADM-05/06",
  "实际日志不含秘密/原始正文，系统错误保留；无法补造崩溃前未落库事件。",
);
N(
  "LOG",
  "21",
  "admin-log-export",
  "empty selection",
  "零记录有效gzip，中断租约不自动重放。",
);
N(
  "LOG",
  "22",
  "admin-log-export",
  "anonymous and ordinary",
  "导出重放和参数/权限保护。",
);
N(
  "LOG",
  "23",
  "admin-log-export",
  "creation audit failure",
  "导出上限排队前拒绝，审计失败回滚。",
);
N(
  "LOG",
  "24",
  "admin-log-export",
  "other administrator",
  "导出任务所有者与下载隔离；期限另由同文件租约用例验收。",
);
N(
  "LOG",
  "25",
  "admin-log-export",
  "queued IDs freeze",
  "持久筛选快照及服务重构后续作；浏览器刷新另验收。",
);
N(
  "LOG",
  "26",
  "admin-log-export",
  "source deletion",
  "导出源丢失明确失败并清部分文件，不产生残缺成功包。",
);
N("LOG", "27", "operations", "ADM-05/06", "旧导出gzip合同及20000上限拒绝。");

N("OPS", "2", "inbox", "MSG-01/03", "真实标题/正文长度、角色与字面文本校验。");
N(
  "OPS",
  "3-4 7",
  "inbox",
  "MSG-01 recipient changes",
  "预览收件快照变化回滚、新账号不补收；取消交互另验收。",
);
N("OPS", "6", "inbox", "MSG-01 stale", "20次并发发送一次投递，旧版本拒绝。");
N(
  "OPS",
  "8",
  "catalog-boundaries",
  "OPS cancel",
  "真实草稿取消幂等及已发消息编辑保护。",
);
N(
  "OPS",
  "9 12",
  "admin-message-insights",
  "ME03",
  "本人群发效果、分页与保留收件记录口径；不能读他人草稿效果。",
);
N(
  "OPS",
  "10",
  "admin-message-insights",
  "ME01",
  "五种分群排除后台、停用、测试账号，不发生投递。",
);
N(
  "OPS",
  "11",
  "admin-message-insights",
  "ME04",
  "超过500拒绝截断，80并发效果查询。",
);
N(
  "OPS",
  "13",
  "admin-moderation",
  "CM05",
  "内容类型列表真实权限和并发读取；UI分页另验收。",
);
N(
  "OPS",
  "14",
  "admin-moderation",
  "CM03",
  "隐藏联动所有公开入口、数据仍存；取消按钮另验收。",
);
N(
  "OPS",
  "15-16",
  "admin-moderation",
  "CM02",
  "并发治理只有一次成功，隐藏评论不删除数据。",
);
N(
  "OPS",
  "17",
  "admin-moderation",
  "CM01",
  "举报折叠幂等、所有者隔离、不自动隐藏。",
);
N(
  "OPS",
  "18",
  "admin-moderation",
  "CM04",
  "处理报告版本保护，审计失败回滚恢复。",
);
N(
  "OPS",
  "19 25",
  "classic-citywalks",
  "CW-01",
  "经典种子与下架状态幂等，重复启动不覆写编辑。",
);
N(
  "OPS",
  "20-22 24",
  "classic-citywalks",
  "admin checks",
  "经典来源URL/地点ID/版本校验及服务端坐标；真实道路提供商和相机另验收。",
);
N(
  "OPS",
  "23",
  "classic-citywalks",
  "verified legs reuse",
  "不把缺路/超15km当可发布，未发布草稿允许保存。",
);

N(
  "JOB",
  "1-3",
  "admin-maintenance",
  "MT01",
  "真实持久任务权限、未知类型拒绝与入队审计回滚；任务完成另有执行断言。",
);
N(
  "JOB",
  "4 8-9",
  "admin-maintenance",
  "health thresholds",
  "采样阈值、分母和陈旧边界；任务分页UI另验收。",
);
N(
  "JOB",
  "5-6",
  "admin-maintenance",
  "MT03",
  "安全取消、失败清洗、重试关联与重复重试。",
);
N(
  "JOB",
  "7",
  "admin-maintenance",
  "MT04",
  "过期执行租约标中断而非成功，不自动重放。",
);
N(
  "JOB",
  "10-11",
  "admin-maintenance",
  "MT06",
  "告警同规则去重，知悉不等于恢复。",
);
N(
  "JOB",
  "12-14",
  "admin-archives",
  "AR01",
  "保留期、北京时间范围、预览幂等与角色；过期确认另需补充断言。",
);
N(
  "JOB",
  "15-16",
  "admin-archives",
  "AR03",
  "502条归档续作、gzip内容SHA及数字时间精度，保护其他审计。",
);
N(
  "JOB",
  "17",
  "admin-archives",
  "AR06",
  "恢复重放不重复，原时间不变，消除虚假归档覆盖。",
);
N(
  "JOB",
  "18",
  "admin-archives",
  "AR05",
  "坏SHA及同ID不同内容拒绝，不覆写现存事件。",
);
N(
  "JOB",
  "19",
  "admin-archives",
  "AR02",
  "第二批写失败仅保留已提交进度，原记录未丢失。",
);
N("JOB", "20", "admin-archives", "AR04", "冻结匿名日汇总与明细缺失准确区分。");
N(
  "JOB",
  "21",
  "admin-log-export",
  "empty selection",
  "失效导出不自动重放；通用任务重试入口仍需专门联调。",
);

N(
  "DATA",
  "1-2",
  "admin-place-quality",
  "PQ01",
  "本地业务统计与远端全库区分，四个覆盖接口独立故障。",
);
B(
  "DATA",
  "3-4",
  "需要连接已部署的真实 OSM 库核对衢州孔庙、故宫、太和殿实体与当前构建版本；合成数据不能证明这些实际记录正确。",
);
N(
  "DATA",
  "5",
  "containment-hierarchy",
  "read transport",
  "完整父子层级及全类别运输合同，真实全库最大8层另验收。",
);
N(
  "DATA",
  "6",
  "admin-place-quality",
  "place quality preserves",
  "类别、来源、site、parent、坐标角色投影相互独立。",
);
N(
  "DATA",
  "7",
  "place-policy",
  "missing or expired facts",
  "用户缺失/过期资料不显示，零值保留。",
);
N(
  "DATA",
  "8",
  "opening-hours",
  "split opening hours",
  "指定日、午间闭馆与周例外规则；临时公告仍需官方证据。",
);
N(
  "DATA",
  "9",
  "routes",
  "catalog rejects",
  "不完整、大范围、无效坐标搜索拒绝。",
);
N(
  "DATA",
  "10",
  "provider-boundaries",
  "OSM transport preserves",
  "受控只读路径和客户端错误，不跨对象/路径取数。",
);
N(
  "DATA",
  "11",
  "place-candidates",
  "a usable local candidate",
  "本地可用不付费，来源不把fee当票价。",
);
N(
  "DATA",
  "12",
  "place-policy",
  "named search recalls",
  "语义最高候选仍受地理和可信规则约束；不代表真实embedding质量。",
);
N(
  "DATA",
  "13-14",
  "journey-candidate-memory",
  "planning reads only",
  "实际紧凑候选、按需详情和归属政策；未连接全量远端库。",
);
N(
  "DATA",
  "15-16",
  "routes",
  "walk / metro / walk",
  "真实解析器分段与缺时长语义，供应商响应使用固定夹具。",
);
N(
  "DATA",
  "17",
  "route-selection",
  "candidate proof binds",
  "候选证明绑定所有者、源POI与路由厂商，拒绝篡改。",
);
N(
  "DATA",
  "18",
  "catalog-boundaries",
  "DATA transport",
  "实际交通能力接口如实返回未配置，不伪造车次航班票价。",
);
N(
  "DATA",
  "19",
  "planner",
  "plan allocates",
  "旧规划算法唯一分配及缺资料警告；旧HTTP完整合同另验收。",
);
N(
  "DATA",
  "20",
  "catalog-boundaries",
  "DATA import",
  "实际地点导入管理员门禁、未知字段和超量边界；不碰全量 OSM。",
);
N(
  "DATA",
  "21",
  "product-events",
  "EVT04",
  "数据库业务数据与迁移幂等验证；重启全业务服务持久化另验收。",
);
N(
  "DATA",
  "22",
  "social-drafts",
  "optimistic drafts",
  "拒绝自报user_id、外部媒体与旧版本，不改变所有权。",
);

N(
  "E2E",
  "1",
  "social-loop",
  "INT-SOCIAL:",
  "真实隔离库旅行→草稿→发布→互动→参考→下次推荐闭环；模型生成使用可控替身。",
);
N(
  "E2E",
  "2-3",
  "iteration-integration",
  "INT-01",
  "游客→登录→核验步行→审计→消息→已读→撤销会话跨模块集成；外部路由使用替身。",
);
N(
  "E2E",
  "4",
  "admin-moderation",
  "CM03",
  "治理立即阻断公开读取和写入，保留可恢复数据。",
);
N(
  "E2E",
  "5",
  "tab-motion",
  "tabs own distinct",
  "独立Lottie状态，同Tab不重播；页面置顶另验收。",
);
N(
  "E2E",
  "6-7",
  "consumer-presentation",
  "rapid page changes",
  "切换动画取消与减少动画规则。",
);
B(
  "E2E",
  "8",
  "所有消费页审美、文字密度和遮挡需要人工逐页视觉验收，不能用 DOM 存在断言替代。",
);
N(
  "E2E",
  "10",
  "catalog-boundaries",
  "E2E desktop",
  "真实浏览器桌面/平板视口横向溢出和基础控件可见性；审美另验收。",
);
B(
  "E2E",
  "11",
  "本机没有 Safari 实机；需在 Windows Chrome/Edge 与 macOS Safari 分别跑核心流程，Chromium移动仿真不是Safari。",
);
B(
  "E2E",
  "12",
  "需要鸿蒙模拟器或真机切换本地/云端连接；当前工具只操作网页，不把浏览器测试冒充原生客户端验收。",
);
N(
  "E2E",
  "13",
  "admin-user-insights",
  "USR04",
  "逐类个人数据和委派角色访问隔离；其他资源由各模块所有权测试覆盖。",
);
N(
  "E2E",
  "15",
  "social-ui",
  "untrusted titles",
  "标题、话题、资料证据等HTML转义；持久化其他文本由对应接口测试补充。",
);
N(
  "E2E",
  "17",
  "catalog-boundaries",
  "POST offline",
  "浏览器真实离线保存失败不误报，恢复后可保存；最终发布幂等另由并发用例覆盖。",
);
N(
  "E2E",
  "19",
  "provider-boundaries",
  "catalog orchestration",
  "远端失败快照回退明示，供应商不拖垮无关功能；真实多供应商连通另验收。",
);
N(
  "E2E",
  "20",
  "catalog-boundaries",
  "E2E selection latency",
  "浏览器本地20次选点记录P95并检查200ms建议线，不执行高德收费路径。",
);
N(
  "E2E",
  "21",
  "catalog-boundaries",
  "E2E list latency",
  "真实本地列表重复读取记录P95，第三方无网络夹具不计入真实云查询性能。",
);
N(
  "E2E",
  "22",
  "journey-candidate-memory",
  "JM05",
  "5043点受限堆子进程连续8份规划，失败会传回报告，不连接远端全库。",
);
B(
  "E2E",
  "23",
  "要求30分钟长时浏览器导航与堆采样；普通一轮不缩短为几秒并声称通过。需单独启动长时验收并保留完整采样。",
);
N(
  "E2E",
  "24",
  "admin-user-insights",
  "USR05",
  "160次读取、8并发，精确账号隔离；属于接口并发而非8个完整浏览器会话。",
);
N(
  "E2E",
  "25",
  "social-drafts",
  "20 simultaneous publish",
  "20并发相同发布只一帖；其他版本冲突由各模块接口用例覆盖。",
);
N(
  "E2E",
  "26",
  "admin-log-export",
  "20,001 rows export",
  "20001行有界分批导出同时60个交互读，无整包堆加载。",
);
B(
  "E2E",
  "27",
  "需要选择目标服务器并核对其部署commit；本地工作区测试不能替代线上固定版本验收。",
);
N(
  "E2E",
  "28",
  "admin-log-export",
  "migrations can repeat",
  "隔离库导出迁移重跑保留已完成记录；完整备份恢复/应用回退另需部署演练。",
);
N(
  "E2E",
  "29",
  "catalog-boundaries",
  "E2E isolation",
  "核验临时库连接与测试数据身份，清理由全局teardown执行；正式库不接入。",
);

const known = new Set(allCases.map((c) => c.id));
for (const id of [...browserIds, ...Object.keys(coverage)])
  if (!known.has(id)) throw Error("Unknown case " + id);
const missing = allCases.filter(
  (c) => !browserIds.has(c.id) && !coverage[c.id],
);
if (missing.length)
  throw Error(
    "Missing explicit execution coverage: " +
      missing.map((c) => c.id).join(","),
  );
if (allCases.length !== 435 || known.size !== 435)
  throw Error("Expected 435 unique catalog cases");
