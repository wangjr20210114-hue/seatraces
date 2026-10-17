// Animate the newly visible panel, never clone maps, forms or private content.
export function createPageMotion({reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches}={}) {
  let running;
  return (element,{animate=false,direction='forward'}={}) => {
    running?.cancel();running=null;
    if(!animate || reduced() || !element?.animate)return;
    running=element.animate([
      {opacity:.3,transform:`translate${direction==='tab'?'Y':'X'}(${direction==='back'?-18:18}px)`},
      {opacity:1,transform:'translate(0,0)'}
    ],{duration:260,easing:'cubic-bezier(.22,.7,.2,1)',fill:'none'});
  };
}
