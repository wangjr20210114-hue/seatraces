// Narrow, read-only allowlist shared by the UI and API gate.
export function guestPage(route){return route.page==='home'||(route.page==='citywalk'&&/^classic-[a-z0-9-]{1,80}$/.test(route.id||''));}
export function guestApiRead(path,method='GET'){return ['GET','HEAD'].includes(method)&&(['/maps/config','/_AMapService/v4/map/styles','/citywalk/classics'].includes(path)||/^\/citywalk\/classics\/[a-z0-9-]{1,80}$/.test(path));}
export function guestMapStyle(path,method='GET'){return ['GET','HEAD'].includes(method)&&path==='/v4/map/styles';}
