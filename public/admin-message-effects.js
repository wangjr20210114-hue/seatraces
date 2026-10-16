const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
export async function showMessageEffects({id,content,status,api,valid,back}){
  let offset=0,state='all',revision=0;
  async function load(){
    const n=++revision;status.textContent='正在加载投递效果…';
    try{const v=await api('/api/admin/messages/'+id+'/effects?'+new URLSearchParams({offset,state}));if(!valid()||n!==revision)return;
      content.innerHTML=`<div class="user-breadcrumb"><button id="effects-back">← 消息列表</button></div><h3>${esc(v.campaign.title)}</h3><div class="metrics">${[['发送时收件人',v.campaign.recipient_count],['仍保留投递',v.totals.stored],['已读',v.totals.read],['未读',v.totals.unread],['已读率',v.totals.readRate===null?'—':v.totals.readRate+'%']].map(([a,b])=>`<article class="metric"><span>${a}</span><strong>${b}</strong></article>`).join('')}</div><p>${esc(v.definition)}</p><p class="table-note">已删除收件记录 ${v.totals.removedRecipientRecords} 条 · 统计于 ${time(v.asOf)}</p><form id="effect-filter" class="filters"><label>阅读状态<select name="state"><option value="all">全部</option><option value="read">已读</option><option value="unread">未读</option></select></label><button>筛选</button></form><div class="table-wrap"><table><thead><tr><th>账号</th><th>昵称</th><th>投递时间</th><th>首次阅读</th></tr></thead><tbody>${v.items.map(x=>`<tr><td>${esc(x.username)}</td><td>${esc(x.nickname)}</td><td>${time(x.created_at)}</td><td>${time(x.read_at)}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">暂无投递</td></tr>'}</tbody></table></div><div class="pager"><button id="effects-prev" ${offset?'':'disabled'}>上一页</button><span>第 ${offset/30+1} 页</span><button id="effects-next" ${v.hasMore?'':'disabled'}>下一页</button></div><article class="admin-card"><h3>最近 31 天首次阅读</h3>${v.daily.map(d=>`<p>${esc(d.day)}：${d.first_reads} 人</p>`).join('')||'<p>暂无阅读记录</p>'}</article>`;
      content.querySelector('#effects-back').onclick=back;content.querySelector('[name=state]').value=state;
      content.querySelector('#effect-filter').onsubmit=e=>{e.preventDefault();state=new FormData(e.target).get('state');offset=0;void load();};
      content.querySelector('#effects-prev').onclick=()=>{offset-=30;void load();};content.querySelector('#effects-next').onclick=()=>{offset+=30;void load();};status.textContent='';
    }catch(e){if(valid()&&n===revision)status.textContent=e.message;}
  }
  await load();
}
