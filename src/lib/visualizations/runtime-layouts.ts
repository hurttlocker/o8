/** Reusable layouts and linked views execute only inside the sealed display sandbox. */
export const VISUALIZATION_LAYOUTS = `
(() => {
  const kit=window.o8Viz, d3=window.d3;
  kit.dashboard=function(target,spec) {
    const root=typeof target==='string'?document.querySelector(target):target;
    if (!(root instanceof HTMLElement)) throw new Error('A dashboard needs an existing container');
    const key=root.id || 'exploration', link=kit.link(key);
    const preferences=()=>kit.getState().dashboards?.[key] || {};
    function savePreferences(value) {
      const state=kit.getState(); kit.setState(Object.assign({},state,{dashboards:Object.assign({},state.dashboards,{[key]:Object.assign({},preferences(),value)})}));
    }
    const allX=[...new Set(spec.series.flatMap(s=>s.values.map(p=>p.x)))].sort((a,b)=>a-b);
    const valueMaps=new Map(spec.series.map(s=>[s.id,new Map(s.values.map(p=>[p.x,p.y]))]));
    const labels=new Map(spec.series.flatMap(s=>s.values.map(p=>[p.x,p.label || String(p.x)])));
    function visibleSelection() {
      const stored=link.get();
      return {seriesId:spec.series.some(s=>s.id===stored.seriesId)?stored.seriesId:undefined,x:allX.includes(stored.x)?stored.x:undefined};
    }
    const colors=new Map(spec.series.map((s,i)=>[s.id,spec.style==='quiet'?'color-mix(in srgb,'+kit.color(i)+' 55%,var(--foreground))':kit.color(i)]));
    const heatSize=42,tableSize=100;
    function choose(selection) {
      const index=allX.indexOf(selection.x); if(index<0) return link.set(selection);
      const state=kit.getState();
      return kit.setState(Object.assign({},state,{links:Object.assign({},state.links,{[key]:selection}),
        dashboards:Object.assign({},state.dashboards,{[key]:Object.assign({},preferences(),{heatPage:Math.floor(index/heatSize),tablePage:Math.floor(index/tableSize)})})}));
    }
    root.className='viz-dashboard'; root.dataset.density=spec.density;
    function node(tag,cls,text) { const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=String(text); return n; }
    function button(label,fn) { const b=node('button','viz-button',label); b.type='button'; b.addEventListener('click',fn); return b; }
    const title=node('h2','viz-heading',spec.title), caption=node('p','viz-caption',spec.caption || 'Explore the values and their relationships.');
    const controls=node('div','viz-controls'), filters=node('div','viz-row'); filters.setAttribute('role','group'); filters.setAttribute('aria-label','Filter series');
    const mode=node('div','viz-tabs'); mode.setAttribute('role','group'); mode.setAttribute('aria-label','Chart style');
    const stats=node('div','viz-grid'), chartRoot=node('div'); chartRoot.id=key+'-chart';
    const selection=node('div','viz-selection'), status=node('p','viz-caption'); status.setAttribute('role','status');
    const reset=button('Clear selection',()=>link.clear()); reset.dataset.variant='ghost'; selection.append(status,reset);
    const detail=node('div','viz-detail'), detailTitle=node('h3'), detailText=node('p','viz-caption'); detail.append(detailTitle,detailText);
    const ask=button('Ask about this selection',()=> {
      const choice=visibleSelection();
      const series=spec.series.filter(s=>!choice.seriesId || s.id===choice.seriesId);
      const values=series.map(s=> {
        const points=s.values.filter(p=>choice.x===undefined || p.x===choice.x),recorded=points.filter(p=>p.y!==null);
        const value=recorded.length?(spec.aggregate==='mean'?d3.mean(recorded,p=>p.y):d3.sum(recorded,p=>p.y)):null;
        const expected=choice.x===undefined?allX.length:1;
        return s.label+': '+(value===null?'missing':value+' '+spec.unit)+' ('+spec.aggregate+', '+recorded.length+' recorded, '+(expected-recorded.length)+' missing)';
      }).join('; ');
      kit.ask('Investigate '+spec.title+'. Selection: '+(choice.x===undefined?'all '+spec.xLabel:labels.get(choice.x))+'. '+values+'. Source: '+spec.source);
    }); ask.dataset.variant='primary'; detail.append(ask);
    const heat=node('section','viz-heatmap'), heatTitle=node('h3',null,'Pattern across series'), heatWrap=node('div','viz-table-wrap');
    heat.append(heatTitle,node('p','viz-caption','Intensity shows magnitude. Hover or focus for exact values; blank cells are missing.'),heatWrap);
    const values=node('details','viz-details'), summary=node('summary',null,'View linked values'), wrap=node('div','viz-table-wrap'), table=node('table','viz-table'); wrap.append(table); values.append(summary,wrap);
    values.addEventListener('toggle',()=> { if(values.open!==Boolean(preferences().valuesOpen)) savePreferences({valuesOpen:values.open}); });
    const source=node('p','viz-caption',spec.source); source.dataset.vizSource='true';
    function pager(size,label) {
      const root=node('div','viz-row'), count=node('span','viz-caption'); root.setAttribute('role','group'); root.setAttribute('aria-label',label+' pages');
      const pref=label==='Pattern'?'heatPage':'tablePage';
      const previous=button('Previous',()=>savePreferences({[pref]:Math.max(0,(preferences()[pref] || 0)-1)}));
      const next=button('Next',()=>savePreferences({[pref]:Math.min(Math.ceil(allX.length/size)-1,(preferences()[pref] || 0)+1)}));
      for(const [b,direction] of [[previous,'Previous'],[next,'Next']]) { b.dataset.variant='ghost'; b.setAttribute('aria-label',direction+' '+label.toLowerCase()+' page'); }
      root.append(previous,count,next);
      return {root,update(selected) { const raw=preferences()[pref],page=Math.max(0,Math.min(Math.ceil(allX.length/size)-1,Number.isSafeInteger(raw)?raw:0));
        root.hidden=allX.length<=size || selected!==undefined; previous.disabled=page===0; next.disabled=(page+1)*size>=allX.length;
        count.textContent=(page*size+1)+'–'+Math.min(allX.length,(page+1)*size)+' of '+allX.length; return page; }};
    }
    const heatPages=pager(heatSize,'Pattern'),tablePages=pager(tableSize,'Values'); heat.append(heatPages.root); values.append(tablePages.root);
    controls.append(filters,mode); root.replaceChildren(title,caption,controls,stats,chartRoot,selection,heat,detail,values,source);
    const chart=kit.chart(chartRoot,{legend:false,table:false,xTicks:allX,xLabel:spec.xLabel,yLabel:spec.unit,formatX:x=>labels.get(x) || String(x),onSelect:point=>choose(Object.assign({},link.get(),{x:point?.x}))});
    const tip=kit.tooltip(heat);
    const seriesButtons=new Map();
    for(const s of [{id:'',label:'All series'},...spec.series]) {
      const b=button(s.label,()=>choose(Object.assign({},link.get(),{seriesId:s.id || undefined}))); b.dataset.filterSeries=s.id; filters.append(b); seriesButtons.set(s.id,b);
      if(s.id) { const swatch=node('span','viz-swatch'); swatch.style.background=colors.get(s.id); b.prepend(swatch); }
    }
    let plot=kit.getState().dashboards?.[key]?.plot || spec.plot;
    const plotButtons=new Map();
    for(const [value,label] of [['line','Trend'],['bar','Compare']]) {
      const b=button(label,()=> { plot=value; savePreferences({plot:value}); });
      mode.append(b); plotButtons.set(value,b);
    }
    const heatButtons=[],grid=node('div','viz-heat-grid'); let heatPage=-1;
    const max=d3.max(spec.series.flatMap(s=>s.values.map(p=>Math.abs(p.y || 0)))) || 1;
    function drawHeat(page) {
      if(page===heatPage || spec.layout!=='explore') return; heatPage=page; grid.replaceChildren(); heatButtons.length=0; tip.hide();
      const xs=allX.slice(page*heatSize,(page+1)*heatSize); grid.style.gridTemplateColumns='minmax(70px,100px) repeat('+xs.length+',minmax(16px,1fr))';
      grid.append(node('span','viz-caption',spec.xLabel));
      for(const [i,x] of xs.entries()) grid.append(node('span','viz-caption',i%Math.max(1,Math.ceil(xs.length/8))===0?labels.get(x):''));
      for(const s of spec.series) {
      const row=button(s.label,()=>choose(Object.assign({},link.get(),{seriesId:s.id}))); row.dataset.variant='ghost'; grid.append(row);
      for(const x of xs) {
        const value=valueMaps.get(s.id).get(x) ?? null;
        const b=button('',()=>choose({seriesId:s.id,x})); b.className='viz-heat-cell'; b.dataset.heatSeries=s.id; b.dataset.heatX=String(x);
        b.setAttribute('aria-label',s.label+', '+labels.get(x)+': '+(value===null?'missing':value+' '+spec.unit));
        b.style.background=value===null?'var(--muted)':'color-mix(in srgb,'+colors.get(s.id)+' '+(15+Math.abs(value)/max*70)+'%,var(--muted))';
        function show(event) { const rect=b.getBoundingClientRect(),bounds=heat.getBoundingClientRect(); tip.show(labels.get(x),[{label:s.label,value:value===null?'Missing':d3.format(',.4~g')(value)+' '+spec.unit,color:colors.get(s.id)}],{x:event.clientX?event.clientX-bounds.left:rect.left-bounds.left,y:rect.bottom-bounds.top}); }
        b.addEventListener('pointermove',show); b.addEventListener('focus',show); b.addEventListener('pointerleave',()=>tip.hide()); b.addEventListener('blur',()=>tip.hide());
        b.addEventListener('keydown',event=> { const index=heatButtons.indexOf(b),offset=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:event.key==='ArrowDown'?xs.length:event.key==='ArrowUp'?-xs.length:0;
          if(offset){event.preventDefault();heatButtons[Math.max(0,Math.min(heatButtons.length-1,index+offset))]?.focus();} });
        heatButtons.push(b); grid.append(b);
      }
      }
    }
    heatWrap.append(grid); heat.hidden=spec.layout!=='explore';
    function apply() {
      const choice=visibleSelection(), seriesId=choice.seriesId, selectedX=choice.x;
      const active=spec.series.filter(s=>!seriesId || s.id===seriesId);
      drawHeat(heatPages.update()); const tablePage=tablePages.update(selectedX);
      plot=kit.getState().dashboards?.[key]?.plot || plot; if(!['line','bar'].includes(plot))plot=spec.plot;
      for(const [id,b] of seriesButtons) b.setAttribute('aria-pressed',String((seriesId || '')===id));
      for(const [value,b] of plotButtons) b.setAttribute('aria-pressed',String(value===plot));
      const points=active.flatMap(s=>s.values.filter(p=>(selectedX===undefined || p.x===selectedX) && p.y!==null));
      stats.replaceChildren();
      const total=points.length?d3.sum(points,p=>p.y):null, average=points.length?d3.mean(points,p=>p.y):null;
      for(const [label,value] of [[spec.aggregate==='mean'?'Average':'Total',spec.aggregate==='mean'?average:total],['Values',points.length],['Series',active.length]]) {
        const block=node('div'); block.append(node('div','viz-caption',label),node('div','viz-value',value===null?'—':d3.format(',.4~g')(value)),node('div','viz-caption',label==='Total' || label==='Average'?spec.unit:'in this selection')); stats.append(block);
      }
      chart.update({type:plot,selectedX,smooth:spec.layout!=='compare',series:active.map(s=>({...s,color:colors.get(s.id)}))});
      const selected=selectedX===undefined?'Full range':labels.get(selectedX);
      status.textContent=(seriesId?spec.series.find(s=>s.id===seriesId).label:'All series')+' · '+selected; reset.hidden=!seriesId && selectedX===undefined;
      detailTitle.textContent=seriesId?spec.series.find(s=>s.id===seriesId).label:'Selection details';
      detailText.textContent=points.length?selected+': '+points.length+' recorded '+(points.length===1?'value':'values')+'. Missing values stay empty. Choose a cell or chart value to focus the linked views.':'No recorded values in this selection.';
      for(const b of heatButtons) { const chosen=(!seriesId || b.dataset.heatSeries===seriesId) && (selectedX===undefined || Number(b.dataset.heatX)===selectedX); b.dataset.selected=String(chosen); b.setAttribute('aria-pressed',String(chosen && (Boolean(seriesId) || selectedX!==undefined))); }
      table.replaceChildren(); const head=node('thead'),tr=node('tr');
      for(const [index,label] of [spec.xLabel,...active.map(s=>s.label+' ('+spec.unit+')')].entries()) { const th=node('th',null,label); th.scope='col'; if(index)th.dataset.numeric='true'; tr.append(th); } head.append(tr); table.append(head);
      const body=node('tbody'),xs=selectedX===undefined?allX.slice(tablePage*tableSize,(tablePage+1)*tableSize):[selectedX];
      for(const x of xs) { const row=node('tr'),label=node('th',null,labels.get(x)); label.scope='row'; row.append(label); for(const s of active) { const value=valueMaps.get(s.id).get(x) ?? null; const td=node('td',null,value===null?'—':d3.format(',.4~g')(value)); td.dataset.numeric='true'; row.append(td); } body.append(row); } table.append(body);
      values.open=Boolean(preferences().valuesOpen);
    }
    const unsubscribe=kit.onState(apply); apply();
    return {destroy(){unsubscribe();chart.destroy();tip.destroy();root.replaceChildren();},selection:()=>link.get()};
  };
})();
`;
