/* 汇总人工偏好选择，生成评审分析结果。 */

import { validateAnswers, summarizeReview } from './preference-review.mjs';
import { summarizeChoiceSemantics } from './preference-review-interpretation.mjs';

const emptyCounts=()=>({firstMethodWins:0,secondMethodWins:0,both:0,neither:0,unsure:0,tasks:0});
const outcomes=['firstMethodWins','secondMethodWins','both','neither','unsure'];

export function aggregateReviews(study, protocol, inputs) {
  if(!Array.isArray(inputs)||inputs.length>1000)throw Error('At most 1000 answer sets are supported');
  if(protocol.protocolId!==study.protocolId)throw Error('Protocol mismatch');
  const seen=new Set(),totals={},byTask=new Map(),reviewers=[];
  for(const input of inputs){
    const answers=validateAnswers(study,input),identity=answers.reviewerId.toLowerCase();
    if(seen.has(identity))throw Error('Multiple submissions from one reviewer; explicitly select their final answer file');
    seen.add(identity);
    const summary=summarizeReview(study,protocol,answers),responses=new Map(answers.responses.map(r=>[r.taskId,r]));
    reviewers.push({reviewerId:identity,repeatAgreements:summary.repeatAgreements,repeats:summary.repeats,
      supplementalInterpretation:summarizeChoiceSemantics(protocol,answers)});
    for(const [key,counts] of Object.entries(summary.totals)){
      const total=totals[key] ||= emptyCounts();for(const field of Object.keys(total))total[field]+=counts[field];
    }
    for(const probe of protocol.probes){
      if(probe.repeatOf)continue;
      const response=responses.get(probe.taskId),task=study.tasks.find(t=>t.id===probe.taskId);
      const row=byTask.get(task.id)||{taskId:task.id,scenario:task.scenario,methods:probe.methods,titles:probe.preferredKeys.map(key=>task.options.find(o=>o.key===key).title),...emptyCounts()};
      row.tasks++;
      if(['first','second'].includes(response.choice)){
        const key=response.order[response.choice==='first'?0:1];row[key===probe.preferredKeys[0]?'firstMethodWins':'secondMethodWins']++;
      }else row[response.choice]++;
      byTask.set(task.id,row);
    }
  }
  const tasks=[...byTask.values()].map(row=>({...row,disagreement:1-Math.max(...outcomes.map(k=>row[k]))/row.tasks})).sort((a,b)=>b.disagreement-a.disagreement||a.taskId.localeCompare(b.taskId));
  return {protocolId:study.protocolId,status:inputs.length?'diagnostic_ready':'awaiting_reviews',reviewerCount:seen.size,
    primaryQuestionCount:protocol.probes.filter(p=>!p.repeatOf).length,totals,tasks,reviewers,
    diagnosticOnly:true,activationAllowed:false,uncertainty:'Selected synthetic-content disagreements, not a representative feed evaluation. Questions from one reviewer are not independent users. No population confidence interval or NDCG is inferred.'};
}

export function renderAnalysis(report){
  const clean=value=>String(value).replace(/[\r\n|]/g,' ').replace(/</g,'&lt;');
  const lines=['# 帖子偏好盲评诊断','',`状态：${report.status}；独立评审者：${report.reviewerCount}；主问题：${report.primaryQuestionCount}。`,'',
    '本报告仅供诊断，不触发模型训练、上线或用户画像更新。重复题不计入方法比较；同一人的多个答案文件不能当作多个人。',''];
  if(!report.reviewerCount)return lines.concat('尚未收到答案，不能给出模型优劣结论。','').join('\n');
  lines.push('| 比较（左 / 右） | 左被选 | 右被选 | 都合适 | 都不合适 | 信息不足 | 有效主问题判断数 |','|---|---:|---:|---:|---:|---:|---:|');
  for(const [name,c] of Object.entries(report.totals))lines.push(`| ${clean(name)} | ${c.firstMethodWins} | ${c.secondMethodWins} | ${c.both} | ${c.neither} | ${c.unsure} | ${c.tasks} |`);
  lines.push('','## 逐题分歧','', '按答案不一致程度降序排列，不把“信息不足”或“两篇都不合适”折算成算法获胜。','',
    '| 题目 | 场景 | 左方法帖子 / 右方法帖子 | 左被选 / 右被选 / 都合适 / 都不合适 / 信息不足 |','|---|---|---|---|');
  for(const t of report.tasks)lines.push(`| ${clean(t.taskId)} | ${clean(t.scenario)} | ${t.titles.map(clean).join(' / ')} | ${outcomes.map(k=>t[k]).join(' / ')} |`);
  lines.push('','## 一致性检查','');
  for(const r of report.reviewers)lines.push(`- ${r.reviewerId}：${r.repeatAgreements}/${r.repeats} 道重复题选项完全一致（原定指标）。`);
  lines.push('','## 选择含义补充（事后诊断）','',
    '以下解释在收集答案后增加，保留原定比较计数与一致性指标，不用于重新计算模型成绩。两篇都合适表示均可推荐，不意味着必须严格同分；只选一篇表达相对偏好，不将另一篇自动视为负样本。','',
    '| 评审者 | 都合适题数 | 相对偏好题数 | 都不合适题数 | 信息不足题数 | 明确合适 / 不合适 / 未定的单篇判断数 |','|---|---:|---:|---:|---:|---|');
  for(const r of report.reviewers){
    const s=r.supplementalInterpretation,p=s.primary;
    lines.push(`| ${r.reviewerId} | ${p.bothSuitableAnswers} | ${p.relativePreferenceAnswers} | ${p.neitherSuitableAnswers} | ${p.unsureAnswers} | ${p.acceptedItemJudgments} / ${p.rejectedItemJudgments} / ${p.unratedItemJudgments} |`);
  }
  lines.push('','这些是指定场景下的判断次数，不等于去重帖子数，更不等于评审者本人的旅行画像。重复题不重复贡献标签；本工具不导出训练标签、不写用户画像。','');
  for(const r of report.reviewers){
    const s=r.supplementalInterpretation.repeats;
    lines.push(`- ${r.reviewerId} 的重复题补充解释：含义可兼容 ${s.compatible} 题，合适与不合适明确相反 ${s.acceptability_conflict} 题，相对偏好反转 ${s.preference_reversal} 题，无法确定 ${s.undetermined} 题。`);
  }
  lines.push('','“都合适”与“更偏好其中一篇”可以兼容；“更偏好其中一篇”与“都不合适”不足以单独判定绝对合适程度是否矛盾。补充解释不取代原定指标，也不是新的模型通过门槛。');
  lines.push('','不一致只用于讨论，不自动删除评审者。题目来自人为挑选的算法分歧且使用既有模拟内容，不代表全量推荐效果，也不是 NDCG 或真实成熟互动。若据此修改模型，这批答案属于开发证据，应另留未见样本复验。','');
  return lines.join('\n');
}
