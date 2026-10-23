/* 加载经典 CityWalk 路线列表。 */

export let classicWalks=[];
export async function loadClassicWalks(api){const r=await api('/api/citywalk/classics');classicWalks=r.items;return classicWalks;}
