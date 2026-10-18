import { z } from "zod";
import { capabilities, pages } from "./catalog.mjs";
import { explicitStyle } from "./memory.mjs";
import { isSoftwareQuestion, bypassConfirmation } from "./dialogue.mjs";

import { compoundTripRequest } from "./travel-language.mjs";

const capabilityIds = capabilities.map((c) => c.id);
const software =
  /(软件|海迹|SeaTraces|界面|页面|功能|行程|CityWalk|citywalk|旅行|路线|导航|高德|景点|餐饮|住宿|酒店|餐厅|账号|昵称|头像|收藏|历史|密码|记忆|偏好|风格|推荐|地图)/i;
const question =
  /(怎么|如何|为什么|为何|是什么|什么区别|有什么|多少|几个|多久|多长|多远|是否支持|能不能|可以.{0,12}吗|能.{0,12}吗|支持.{0,12}吗|流程|规则|原理|介绍|说明|请问)/;
const imperative =
  /(帮我|替我|给我|请(?:你)?|打开|进入|跳到|带我去|创建|新建|制订|制定|生成|规划|修改|改成|改为|换成|删除|清空|移除|标记|恢复|发布|分享|转发|记住|忘掉|推荐|安排|我想去|我要去)/;
const danger =
  /(私钥|api[_ ]?key|\.env|数据库密码|执行.{0,12}(SQL|shell|命令)|sudo|绕过.{0,8}(权限|登录|确认)|别人的.{0,8}(行程|账号)|他人的.{0,8}(行程|数据)|管理员权限)/i;
export function pageFromText(text) {
  return Object.entries(pages)
    .sort((a, b) => b[1].level - a[1].level)
    .find(([_, p]) =>
      p.words.some((w) => text.toLowerCase().includes(w.toLowerCase())),
    )?.[0];
}
export function ruleIntent(text) {
  if (danger.test(text))
    return { intent: "other", blocked: true, confidence: 1, source: "policy" };
  if (
    /(其他|全部|所有|别的).{0,4}用户.{0,12}(行程|数据|账号)|忽略.{0,8}(规则|限制|权限)|冒充.{0,8}管理员/.test(
      text,
    ) ||
    bypassConfirmation(text)
  )
    return { intent: "other", blocked: true, confidence: 1, source: "policy" };
  if (/^(取消|算了|停止|先不做|放弃)[。！! ]*$/.test(text))
    return { intent: "cancel", confidence: 1, source: "rule" };
  if (
    /(预订|订房|订餐|付款|转账|下单|买票|操作服务器|执行代码)/.test(text) &&
    imperative.test(text)
  )
    return { intent: "other", blocked: true, confidence: 1, source: "policy" };
  if (
    /(然后|并且|同时|顺便|再帮我).{0,12}(删除|清空|修改|改为|改成|发布|创建|生成|打开|记住|预订)/.test(
      text,
    )
  )
    return { intent: "clarify", confidence: 1, source: "rule_abstain" };
  if (isSoftwareQuestion(text))
    return { intent: "software_question", confidence: 0.98, source: "rule" };
  if (
    /^(帮我|给我|请)?(改一下|改一改|处理一下|安排一下|看看|这个怎么办|这个怎么弄)[。？！!? ]*$/.test(
      text,
    )
  )
    return { intent: "clarify", confidence: 1, source: "rule_abstain" };
  if (
    /(不要|别|不想|不能|不许|无需).{0,5}(清空|删除|修改|发布|创建|生成|规划|打开|记住)|^(如果|假如|比如|例如)/.test(
      text,
    )
  )
    return { intent: "clarify", confidence: 1, source: "rule_abstain" };
  // Questions about an operation are not instructions to perform it.
  if (
    question.test(text) &&
    !/(帮我|替我|给我).{0,6}(打开|创建|规划|生成|修改|清空|删除|推荐)/.test(
      text,
    )
  )
    return software.test(text)
      ? { intent: "software_question", confidence: 0.96, source: "rule" }
      : null;
  if (/(忘掉|删除|清空).{0,10}(旅行风格|旅行偏好|记忆)/.test(text))
    return op("forget_memory");
  if (compoundTripRequest(text)) return op("create_trip");
  if (
    Object.keys(explicitStyle(text)).length ||
    /(记住|记一下|记录).{0,15}(我|偏好|风格)/.test(text)
  )
    return op("memory");
  if(/(?:下午|上午).{0,15}(?:太累|太赶|少安排)|保留.{1,40}(?:其余|重新安排)|(?:这个博物馆|这家博物馆).{0,15}(?:不想去|换个)/.test(text))return op('edit_trip');
  if (!imperative.test(text)) return null;
  if (/(头像|密码|邮箱|退出登录|切换账号)/.test(text))
    return op("account_secure");
  if (/(清空|删除).{0,12}(历史浏览|浏览历史)/.test(text))
    return op("clear_history");
  if (/(昵称|名字).{0,10}(改|换)|(?:修改|改成|改为).{0,8}昵称/.test(text))
    return op("profile_update");
  if (
    /(发布|分享|转发).{0,12}(行程|旅行|路线|发现)|(?:行程|路线).{0,12}(发布|分享|转发)/.test(
      text,
    )
  )
    return op("share_trip");
  if (/(点赞|收藏|推荐).{0,12}帖子|给.{0,20}(点个赞|点赞)/.test(text))
    return op("post_reaction");
  if (/(评论|留言).{0,12}帖子|给.{0,20}(评论|留言)/.test(text))
    return op("post_comment");
  if (/(标记|改为|设为).{0,15}(已完成|完成|计划中)/.test(text))
    return op("trip_status");
  if (/恢复.{0,20}(版本|行程)/.test(text)) return op("trip_restore");
  if (
    /(删除|去掉|移除|添加|增加|替换|调换|调整|修改|改成|改为|移动).{0,40}(景点|行程|路线)|(?:行程|路线).{0,20}(修改|轻松|少一点)/.test(
      text,
    )
  )
    return op("edit_trip");
  if (/(餐饮|餐厅|饭店|吃饭|住宿|酒店|旅店|民宿)/.test(text))
    return op("recommend_services");
  if (
    /(CityWalk|城市漫步)/i.test(text) &&
    /(创建|新建|编辑|画一条|制定|制订)/.test(text)
  )
    return op("create_citywalk");
  if (
    /(规划|制订|制定|生成|安排|我想去|我要去)/.test(text) &&
    /(旅行|旅游|行程|玩|去)/.test(text)
  )
    return op("create_trip");
  if (/旅行报告/.test(text)) return op("report");
  const page = pageFromText(text);
  if (page) return { ...op("navigate"), page };
  return null;
}
const op = (capability) => ({
  intent: "operate",
  capability,
  confidence: 0.98,
  source: "rule",
});
const modelResult = z
  .object({
    intent: z.enum(["operate", "software_question", "other", "clarify"]),
    capability: z.enum(capabilityIds).nullable(),
    confidence: z.number().min(0).max(1),
    evidence: z.string().max(300),
  })
  .strict();
export async function classify(text, { model, search, enabled = true } = {}) {
  const rule = ruleIntent(text);
  if (rule) return rule;
  const retrieval = software.test(text) && search ? await search(text) : null;
  if (enabled && model)
    try {
      const r = modelResult.parse(
        await model(
          "分类用户意图：operate=明确要求操作软件，software_question=询问软件，other=其他闲聊，clarify=证据不足。问怎么做、能否支持不是授权执行。仅在明确祈使请求时选择operate。返回 {intent,capability:白名单ID或null,confidence:0到1,evidence:用户原文逐字片段}。不得执行工具。",
          {
            text,
            capabilities,
            knowledgeTitles: retrieval?.documents.map((d) => d.title) || [],
          },
          { maxTokens: 400 },
        ),
      );
      if (
        r.intent === "operate" &&
        (!imperative.test(text) ||
          r.confidence < 0.9 ||
          !r.capability ||
          !r.evidence ||
          !text.includes(r.evidence))
      )
        return {
          intent: "clarify",
          confidence: r.confidence,
          source: "model_abstain",
        };
      if (r.confidence < 0.7)
        return {
          intent: "clarify",
          confidence: r.confidence,
          source: "model_abstain",
        };
      return { ...r, source: "model" };
    } catch {}
  return {
    intent: software.test(text)
      ? "software_question"
      : imperative.test(text)
        ? "clarify"
        : "other",
    confidence: 0.6,
    source: "fallback",
  };
}
