// Three real Lottie instances: independent timelines, no shared sliding backdrop.
const color = [0.094, 0.235, 0.251, 1];
const still = k => ({ a: 0, k });
const frames = values => ({ a: 1, k: values.map(([t, value], i) => ({ t, s: [value], ...(i < values.length - 1 ? { o: { x: 0.25, y: 0 }, i: { x: 0.75, y: 1 } } : {}) })) });
const line = (points, closed = false) => ({ ty: 'sh', ks: still({ v: points, i: points.map(() => [0,0]), o: points.map(() => [0,0]), c: closed }) });
const ellipse = (x,y,w,h) => ({ ty: 'el', p: still([x,y]), s: still([w,h]), d: 1 });
function animationData(page) {
  const paths = page === 'home'
    ? [line([[5,9],[13,6],[21,9],[29,6],[29,25],[21,28],[13,25],[5,28]], true), line([[13,6],[13,25]]), line([[21,9],[21,28]])]
    : page === 'discover'
      ? [ellipse(17,17,25,25),line([[23,11],[19,19],[11,23],[15,15]],true)]
      : [ellipse(17,11,9,9),line([[7,28],[7,24],[10,20],[17,18],[24,20],[27,24],[27,28]])];
  return { v: '5.12.2', fr: 60, ip: 0, op: 36, w: 34, h: 34, nm: 'SeaTraces ' + page, ddd: 0, assets: [], layers: [{
    ty: 4, ind: 1, nm: page, ddd: 0, st: 0, ip: 0, op: 36, sr: 1,
    ks: { o: still(100), r: frames(page === 'discover' ? [[0,0],[15,28],[25,-8],[35,0]] : [[0,0],[12,-9],[23,6],[35,0]]),
      p: still([17,17,0]), a: still([17,17,0]), s: still([100,100,100]) },
    shapes: [...paths,{ ty: 'st', c: still(color), o: still(100), w: still(2.2), lc: 2, lj: 2 }],
  }] };
}
export function createTabMotion({ buttons, lottie, reducedMotion }) {
  const animations = new Map();
  for (const button of buttons) {
    const container = button.querySelector('.nav-icon');
    if (!lottie) continue; // Keep the static SVG if the optional renderer cannot load.
    container.replaceChildren();
    const animation = lottie.loadAnimation({ container, renderer: 'svg', loop: false, autoplay: false, animationData: animationData(button.dataset.page) });
    animations.set(button.dataset.page, animation);
  }
  let active = 'home';
  return {
    select(page, { animate = true } = {}) {
      if (page === active) return false;
      animations.get(active)?.goToAndStop(0, true);
      active = page;
      const animation = animations.get(page);
      if (!animate || reducedMotion()) animation?.goToAndStop(0, true);
      else animation?.goToAndPlay(0, true);
      return true;
    },
  };
}
