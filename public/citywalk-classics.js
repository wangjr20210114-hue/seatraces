// Canonical classic routes are managed and persisted by the backend.
export let classicWalks=[];
export async function loadClassicWalks(api){const r=await api('/api/citywalk/classics');classicWalks=r.items;return classicWalks;}
