// Every management route must be registered here. Unknown routes fail closed,
// including for owners, so a new endpoint cannot accidentally bypass review.
export const roles = Object.freeze({
  administrator: {name:'管理员', permissions:['*']},
  operator: {name:'运营', permissions:['overview.read','analytics.read','users.list','messages.manage','classics.manage','places.read','content.manage']},
  support: {name:'客服', permissions:['overview.read','users.list','users.read','journeys.read','events.read']},
  analyst: {name:'只读分析', permissions:['overview.read','analytics.read']},
});
export function managementAccess(user) {
  if(!user || user.disabled_at || /^demo_[a-f0-9]{8}$/.test(user.username||'')) return null;
  const role = user.role==='admin' ? 'administrator' : user.management_enabled ? user.management_role : null;
  return roles[role] ? {role,name:roles[role].name,permissions:[...roles[role].permissions],version:role==='administrator'?0:user.management_version} : null;
}
export const can=(access,permission)=>!!access && (access.permissions.includes('*')||access.permissions.includes(permission));
const rules=[
  ['GET',/^\/maintenance\/tasks(?:\/[^/]+)?$/, 'tasks.read'],
  ['POST',/^\/maintenance\/tasks(?:\/[^/]+\/(cancel|retry))?$/, 'tasks.manage'],
  ['GET',/^\/maintenance\/(health|alerts)$/, 'system.read'],
  ['POST',/^\/maintenance\/alerts\/[^/]+\/acknowledge$/, 'system.manage'],
  ['GET',/^\/content(?:\/(posts|comments)\/[^/]+)?$/, 'content.manage'],
  ['PATCH',/^\/content\/(posts|comments)\/[^/]+\/visibility$/, 'content.manage'],
  ['GET',/^\/content-reports$/, 'content.manage'],
  ['PATCH',/^\/content-reports\/[^/]+$/, 'content.manage'],
  ['GET',/^\/access$/, 'overview.read'],
  ['GET',/^\/access\/members$/, 'roles.manage'],
  ['PUT',/^\/access\/members\/[^/]+$/, 'roles.manage'],
  ['GET',/^\/overview$/, 'overview.read'],
  ['GET',/^\/analytics\/(overview|funnels|retention|segments)$/, 'analytics.read'],
  ['GET',/^\/analytics\/scope$/, 'users.manage'],
  ['GET',/^\/agent\/conversations(?:\/[^/]+)?$/, 'agent.read'],
  ['GET',/^\/journeys$/, 'journeys.read'],
  ['GET',/^\/journeys\/trips\/[^/]+(?:\/compare)?$/, 'journeys.read'],
  ['GET',/^\/journeys\/citywalks\/[^/]+$/, 'journeys.read'],
  ['PATCH',/^\/users\/[^/]+\/analytics$/, 'users.manage'],
  ['GET',/^\/users$/, 'users.list'],
  ['GET',/^\/users\/[^/]+$/, 'users.read'],
  ['GET',/^\/users\/[^/]+\/(summary|timeline|trips|citywalks|preferences|visits|messages)$/, 'users.read'],
  ['PATCH',/^\/users\/[^/]+\/status$/, 'users.manage'],
  ['POST',/^\/users\/[^/]+\/sessions\/revoke$/, 'users.manage'],
  ['GET',/^\/events\/export$/, 'events.export'],
  ['GET',/^\/events(?:\/[^/]+)?$/, 'events.read'],
  ['GET',/^\/tasks$/, 'tasks.read'],
  ['GET',/^\/cities$/, 'classics.manage'],
  ['GET',/^\/citywalk\/places$/, 'classics.manage'],
  ['GET',/^\/citywalks$/, 'classics.manage'],
  ['POST',/^\/citywalks$/, 'classics.manage'],
  ['PUT',/^\/citywalks\/[^/]+$/, 'classics.manage'],
  ['PATCH',/^\/citywalks\/[^/]+\/visibility$/, 'classics.manage'],
  ['GET',/^\/messages(?:\/[^/]+\/preview)?$/, 'messages.manage'],
  ['GET',/^\/messages\/audience$/, 'messages.manage'],
  ['GET',/^\/messages\/[^/]+\/effects$/, 'messages.manage'],
  ['POST',/^\/messages(?:\/[^/]+\/(send|cancel))?$/, 'messages.manage'],
  ['PUT',/^\/messages\/[^/]+$/, 'messages.manage'],
  ['POST',/^\/places\/import$/, 'places.manage'],
  ['GET',/^\/places\/(quality|coverage|search|inspect)$/, 'places.read'],
];
export function routePermission(method,path) {
  return rules.find(([verb,pattern])=>verb===(method==='HEAD'?'GET':method)&&pattern.test(path.replace(/\/$/,'')))?.[2] || null;
}
export function authorizeManagement(req,res,next) {
  const permission=routePermission(req.method,req.path);
  if(!permission||!can(req.adminAccess,permission))return res.status(403).json({error:'没有此后台操作权限',code:'management_forbidden'});
  next();
}
export const requireManagement=(req,res,next)=>req.adminAccess&&!req.user?.disabled_at?next():res.status(403).json({error:'需要后台权限'});
