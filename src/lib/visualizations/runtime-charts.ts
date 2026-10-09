/** Responsive D3 defaults. Advanced plots can use the same bundled global directly. */
export const VISUALIZATION_CHARTS = `
(() => {
  const d3 = window.d3, kit = window.o8Viz;
  if (!d3 || !kit) return;
  let sequence = 0;
  kit.chart = function(target, options) {
    const root = typeof target==='string' ? document.querySelector(target) : target;
    if (!(root instanceof HTMLElement)) throw new Error('o8Viz.chart needs an existing container');
    const key = root.id || 'chart-'+(++sequence);
    let config = Object.assign({type:'line',height:260,includeZero:true,smooth:true},options);
    let series = [], allX = [], hidden = new Set(), focusedX = null, pinned = false, lastWidth = 0, destroyed = false;
    const figure = document.createElement('figure'); figure.className = 'viz-chart';
    const legend = document.createElement('div'); legend.className = 'viz-chart-legend';
    const plot = document.createElement('div'); plot.style.position = 'relative';
    const svg = d3.select(plot).append('svg').attr('role','img');
    const grid = svg.append('g'), marks = svg.append('g'), points = svg.append('g'), xAxis = svg.append('g'), yAxis = svg.append('g');
    const empty = svg.append('text').attr('text-anchor','middle');
    const axisLabelX = svg.append('text'), axisLabelY = svg.append('text');
    const guide = svg.append('line').attr('stroke','var(--border)').attr('stroke-dasharray','3 4').style('display','none');
    const markers = svg.append('g');
    const hit = document.createElement('button'); hit.type = 'button'; hit.dataset.chartHit = 'true';
    Object.assign(hit.style,{position:'absolute',border:'0',padding:'0',background:'transparent',cursor:'crosshair',touchAction:'pan-y'});
    const description = document.createElement('div'); description.className = 'viz-sr-only'; description.setAttribute('aria-live','polite');
    const details = document.createElement('details'); details.className = 'viz-details';
    const summary = document.createElement('summary'); summary.textContent = 'View values';
    const tableWrap = document.createElement('div'); tableWrap.className = 'viz-table-wrap';
    const table = document.createElement('table'); table.className = 'viz-table'; tableWrap.append(table); details.append(summary,tableWrap);
    plot.append(hit); figure.append(legend,plot,description,details); root.replaceChildren(figure);
    const tip = kit.tooltip(figure);
    let x, y, width = 0, height = 260, margin;
    function formatX(value) {
      if (config.formatX) return String(config.formatX(value));
      return series.some(s => s.dates) ? d3.timeFormat('%b %-d')(new Date(value)) : d3.format('~g')(value);
    }
    function formatY(value) { return config.formatY ? String(config.formatY(value)) : d3.format('.3~s')(value); }
    function read() {
      let count = 0;
      series = (config.series || []).slice(0,12).map((s,index) => {
        if ((s.values || []).length > 10000 || (count += (s.values || []).length) > 20000) throw new Error('Aggregate chart data to at most 20,000 points');
        return {id:String(s.id || index),label:String(s.label || s.id || 'Series '+(index+1)),color:s.color || 'var(--chart-'+(index%6+1)+')',index,
          dates:(s.values || []).some(point => point.x instanceof Date),
          values:(s.values || []).filter(point => point.x!==null && Number.isFinite(Number(point.x))).map(point => ({x:Number(point.x),y:point.y===null || point.y===undefined || !Number.isFinite(Number(point.y)) ? null : Number(point.y)})).sort((a,b) => a.x-b.x)};
      });
      // Ask D3 for the curve's control points once, so hover markers follow the
      // actual monotone curve rather than an unrelated straight interpolation.
      for (const s of series) {
        s.curves = new Map(); let previous = null;
        const context = {moveTo(x,y) { previous={x,y}; },lineTo(x,y) { previous={x,y}; },closePath() {},
          bezierCurveTo(x1,y1,x2,y2,x,y) { s.curves.set(x,{x0:previous.x,y0:previous.y,y1,y2,y3:y}); previous={x,y}; }};
        if (config.smooth) d3.line().defined(point => point.y!==null).x(point => point.x).y(point => point.y).curve(d3.curveMonotoneX).context(context)(s.values);
      }
      allX = [...new Set(series.flatMap(s => s.values.map(point => point.x)))].sort((a,b) => a-b);
      const stored = kit.getState().charts?.[key]?.hidden;
      hidden = new Set(Array.isArray(stored) ? stored.filter(id => typeof id==='string') : []);
      svg.attr('aria-label',config.description || [config.xLabel,config.yLabel].filter(Boolean).join(' by ') || 'Interactive chart');
      hit.setAttribute('aria-label','Explore '+(config.description || 'chart values')+'. Use left and right arrow keys; Home and End reach the first and last values. Enter or Space selects a value; Escape clears.');
    }
    function valueAt(s,value) {
      const index = d3.bisector(point => point.x).left(s.values,value), exact = s.values[index];
      if (exact && exact.x===value) return exact.y;
      if (config.type==='bar') return null;
      const before = s.values[index-1], after = s.values[index];
      if (!before || !after || before.y===null || after.y===null || after.x===before.x) return null;
      const curve = s.curves.get(after.x);
      if (config.smooth && curve && curve.x0===before.x) {
        const t=(value-before.x)/(after.x-before.x), u=1-t;
        return u*u*u*curve.y0+3*u*u*t*curve.y1+3*u*t*t*curve.y2+t*t*t*curve.y3;
      }
      return before.y+(after.y-before.y)*(value-before.x)/(after.x-before.x);
    }
    function mark(value) {
      const visible = series.filter(s => !hidden.has(s.id));
      const guideX = config.type==='bar' ? x(value)+x.bandwidth()/2 : x(value);
      guide.attr('data-chart-x',Number(value)).attr('x1',guideX).attr('x2',guideX).attr('y1',margin.top).attr('y2',height-margin.bottom).style('display',null);
      const valid = visible.map(s => ({series:s,value:valueAt(s,value)})).filter(row => row.value!==null);
      markers.selectAll('circle').data(config.type==='bar' ? [] : valid,row => row.series.id).join('circle')
        .attr('cx',guideX).attr('cy',row => y(row.value)).attr('r',3.5).attr('fill',row => row.series.color)
        .attr('stroke','var(--background)').attr('stroke-width',2).attr('pointer-events','none');
      return guideX;
    }
    function show(value,point,announce) {
      focusedX = value;
      const visible = series.filter(s => !hidden.has(s.id));
      const rows = visible.map(s => { const result=valueAt(s,value), exact=s.values[d3.bisector(point => point.x).left(s.values,value)]?.x===value;
        return {label:s.label,value:result===null ? '—' : (exact?'':'≈ ')+formatY(result),color:s.color}; });
      const guideX = mark(value);
      const plotBounds = plot.getBoundingClientRect(), bounds = figure.getBoundingClientRect();
      const at = point || {x:guideX,y:margin.top+25};
      tip.show(formatX(value),rows,{x:at.x+plotBounds.left-bounds.left,y:at.y+plotBounds.top-bounds.top});
      if (announce) description.textContent = formatX(value)+'. '+rows.map(row => row.label+': '+row.value).join('. ');
    }
    function hide() {
      guide.style('display','none'); markers.selectAll('*').remove(); tip.hide();
      if (typeof config.selectedX==='number' && allX.includes(config.selectedX)) mark(config.selectedX);
    }
    function save() {
      const state = kit.getState();
      kit.setState(Object.assign({},state,{charts:Object.assign({},state.charts,{[key]:{hidden:[...hidden]}})}));
    }
    function drawLegend() {
      const focused = legend.contains(document.activeElement) ? document.activeElement?.dataset.series : null;
      legend.replaceChildren(); legend.hidden = config.legend===false || series.length < 2;
      if (config.legend===false) return;
      for (const s of series) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.series=s.id; button.setAttribute('aria-pressed',String(!hidden.has(s.id)));
        const swatch = document.createElement('span'); swatch.className = 'viz-swatch'; swatch.style.background = s.color;
        button.append(swatch,document.createTextNode(s.label));
        button.addEventListener('click',() => { if (hidden.has(s.id)) hidden.delete(s.id); else hidden.add(s.id); save(); draw(false); if (focusedX!==null) show(focusedX,null,true); });
        legend.append(button);
        if (s.id===focused) button.focus();
      }
    }
    function drawTable() {
      details.hidden = config.table===false;
      if (config.table===false) return;
      table.replaceChildren();
      const header = document.createElement('thead'), row = document.createElement('tr');
      for (const [index,label] of [config.xLabel || 'Value',...series.map(s => s.label)].entries()) {
        const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; if (index) th.dataset.numeric = 'true'; row.append(th);
      }
      header.append(row); table.append(header); const body = document.createElement('tbody');
      // A disclosure is an accessible values view, not a second giant visualization.
      for (const value of allX.slice(0,200)) {
        const tr = document.createElement('tr'), label = document.createElement('th'); label.scope = 'row'; label.textContent = formatX(value); tr.append(label);
        for (const s of series) { const td = document.createElement('td'), point = s.values.find(point => point.x===value); td.dataset.numeric = 'true'; td.textContent = point?.y===null || point?.y===undefined ? '—' : formatY(point.y); tr.append(td); }
        body.append(tr);
      }
      table.append(body); summary.textContent = allX.length > 200 ? 'View first 200 values' : 'View values';
    }
    function draw(animate) {
      if (destroyed) return;
      width = Math.max(160,root.clientWidth); lastWidth = width; height = Math.max(200,Math.min(400,Number(config.height)||260));
      const values = series.flatMap(s => s.values.filter(point => point.y!==null).map(point => point.y));
      let domainY = d3.extent(values); if (!values.length) domainY = [0,1];
      if (config.includeZero || config.type==='bar') domainY = [Math.min(0,domainY[0]),Math.max(0,domainY[1])];
      if (domainY[0]===domainY[1]) domainY = [domainY[0]-Math.abs(domainY[0]||1)*.1,domainY[1]+Math.abs(domainY[1]||1)*.1];
      const textWidth = Math.max(...domainY.map(value => formatY(value).length),3)*6;
      margin = {top:25,right:12,bottom:44,left:Math.min(width*.35,Math.max(48,textWidth+14))};
      svg.attr('viewBox','0 0 '+width+' '+height).attr('height',height);
      const domainX = d3.extent(allX); if (!allX.length) { domainX[0]=0; domainX[1]=1; }
      if (domainX[0]===domainX[1]) { domainX[0]-=.5; domainX[1]+=.5; }
      x = config.type==='bar' ? d3.scaleBand().domain(allX).range([margin.left,width-margin.right]).padding(.3)
        : (series.some(s => s.dates) ? d3.scaleUtc() : d3.scaleLinear()).domain(domainX).range([margin.left,width-margin.right]);
      y = d3.scaleLinear().domain(domainY).nice(4).range([height-margin.bottom,margin.top]);
      grid.attr('transform','translate('+margin.left+',0)').call(d3.axisLeft(y).ticks(4).tickSize(-(width-margin.left-margin.right)).tickFormat(''));
      grid.select('.domain').remove(); grid.selectAll('line').attr('stroke-opacity',.6);
      const ticks = Math.max(2,Math.min(7,Math.floor((width-margin.left)/90)));
      const bottom = d3.axisBottom(x).tickSize(0).tickPadding(12).tickFormat(value => formatX(Number(value)));
      const tickValues = config.xTicks || (config.type==='bar' ? allX : null);
      if (tickValues) bottom.tickValues(tickValues.filter((_,index) => index%Math.max(1,Math.ceil(tickValues.length/ticks))===0)); else bottom.ticks(ticks);
      xAxis.attr('transform','translate(0,'+(height-margin.bottom)+')').call(bottom);
      yAxis.attr('transform','translate('+margin.left+',0)').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(10).tickFormat(formatY)); yAxis.select('.domain').remove();
      const xText = xAxis.selectAll('text').nodes();
      xText.forEach((node,index) => { if (index===0) node.setAttribute('text-anchor','start'); if (index===xText.length-1) node.setAttribute('text-anchor','end'); });
      // Remove colliding intermediate ticks after measuring the actual font.
      let lastRight = -Infinity;
      xText.forEach((node,index) => { const bounds=node.getBoundingClientRect(); if (index && index<xText.length-1 && bounds.left<lastRight+8) node.style.visibility='hidden'; else lastRight=bounds.right; });
      if (xText.length>1) { const final=xText.at(-1).getBoundingClientRect(); for (const node of xText.slice(0,-1)) if (node.getBoundingClientRect().right>final.left-8) node.style.visibility='hidden'; }
      axisLabelY.attr('x',margin.left).attr('y',12).text(config.yLabel || '');
      axisLabelX.attr('x',(margin.left+width-margin.right)/2).attr('y',height-3).attr('text-anchor','middle').text(config.xLabel || '');
      const visible = series.filter(s => !hidden.has(s.id));
      const hasValues = visible.some(s => s.values.some(point => point.y!==null));
      empty.attr('x',(margin.left+width-margin.right)/2).attr('y',(margin.top+height-margin.bottom)/2)
        .text(hasValues ? '' : hidden.size && series.length ? 'Select a series to explore' : 'No data to display');
      const canAnimate = animate && !matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (config.type==='bar') {
        marks.selectAll('path').remove();
        const sub = d3.scaleBand().domain(visible.map(s => s.id)).range([0,x.bandwidth()]).padding(.14);
        const bars = visible.flatMap(s => s.values.filter(point => point.y!==null).map(point => ({...point,series:s})));
        const rectangles = marks.selectAll('rect').data(bars,point => point.series.id+':'+point.x).join('rect').attr('fill',point => point.series.color).attr('rx',2);
        rectangles.interrupt();
        (canAnimate ? rectangles.transition().duration(160).ease(d3.easeCubicOut) : rectangles)
          .attr('x',point => x(point.x)+sub(point.series.id)).attr('width',sub.bandwidth())
          .attr('y',point => y(Math.max(0,point.y))).attr('height',point => Math.abs(y(point.y)-y(0)));
      } else {
        marks.selectAll('rect').remove();
        const line = d3.line().defined(point => point.y!==null).x(point => x(point.x)).y(point => y(point.y)).curve(config.smooth ? d3.curveMonotoneX : d3.curveLinear);
        const paths = marks.selectAll('path').data(visible,s => s.id).join('path').attr('fill','none').attr('stroke',s => s.color)
          .attr('stroke-width',2).attr('stroke-linecap','round').attr('stroke-linejoin','round');
        paths.each(function(s) {
          const path=d3.select(this), shape=s.values.map(point => point.y===null?'0':'1').join('');
          const sameShape=this.dataset.shape===shape; path.interrupt();
          (canAnimate && sameShape ? path.transition().duration(160).ease(d3.easeCubicOut) : path).attr('d',line(s.values)); this.dataset.shape=shape;
        });
      }
      const single = config.type==='bar' ? [] : visible.flatMap(s => { const valid=s.values.filter(point => point.y!==null); return valid.length===1 ? [{...valid[0],series:s}] : []; });
      points.selectAll('circle').data(single,point => point.series.id).join('circle').attr('cx',point => x(point.x)).attr('cy',point => y(point.y)).attr('r',3).attr('fill',point => point.series.color);
      Object.assign(hit.style,{left:margin.left+'px',right:margin.right+'px',top:margin.top+'px',width:'auto',height:(height-margin.bottom-margin.top)+'px'});
      drawLegend(); hide();
      if (!allX.length) description.textContent='No data to display.';
    }
    function pointValue(event) {
      const bounds=plot.getBoundingClientRect(), at={x:Math.max(margin.left,Math.min(width-margin.right,event.clientX-bounds.left)),y:event.clientY-bounds.top};
      const value=config.type==='bar' ? allX[Math.min(allX.length-1,Math.max(0,Math.floor((at.x-margin.left)/(width-margin.left-margin.right)*allX.length)))] : x.invert(at.x);
      return {value,at};
    }
    hit.addEventListener('pointermove',event => { if (event.pointerType==='touch' || pinned || !allX.length) return; const {value,at}=pointValue(event); show(value,at,false); });
    hit.addEventListener('pointerleave',() => { if (!pinned) hide(); });
    function select(value) { if (typeof config.onSelect==='function') config.onSelect(value===null ? null : {x:allX[d3.bisectCenter(allX,value)]}); }
    hit.addEventListener('pointerdown',event => { if (!allX.length) return; const {value,at}=pointValue(event); pinned=!pinned; if (pinned) show(value,at,true); else hide(); select(pinned ? value : null); });
    hit.addEventListener('focus',() => { if (allX.length) show(focusedX ?? allX[0],null,true); });
    hit.addEventListener('blur',() => { pinned=false; hide(); });
    hit.addEventListener('keydown',event => {
      if (event.key==='Escape') { pinned=false; hide(); select(null); return; }
      if (['Enter',' '].includes(event.key) && focusedX!==null) { event.preventDefault(); select(focusedX); return; }
      if (!allX.length || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); const index=d3.bisectCenter(allX,focusedX ?? allX[0]);
      const next=event.key==='Home'?0:event.key==='End'?allX.length-1:Math.max(0,Math.min(allX.length-1,index+(event.key==='ArrowRight'?1:-1)));
      show(allX[next],null,true);
    });
    const observer=new ResizeObserver(() => { if (root.clientWidth!==lastWidth) draw(false); }); observer.observe(root);
    const unsubscribe=kit.onState(state => { const stored=state.charts?.[key]?.hidden; hidden=new Set(Array.isArray(stored)?stored.filter(id => typeof id==='string'):[]); draw(false); });
    read(); draw(false); drawTable();
    return {
      update(next,interaction={}) { config=Object.assign({},config,next); read(); draw(interaction.animate && !interaction.keyboard); drawTable(); if (pinned && focusedX!==null) show(focusedX,null,true); },
      selected() { return focusedX===null ? null : {x:focusedX,label:formatX(focusedX),series:series.filter(s => !hidden.has(s.id)).map(s => ({id:s.id,label:s.label,value:valueAt(s,focusedX)}))}; },
      destroy() { destroyed=true; observer.disconnect(); unsubscribe(); tip.destroy(); marks.selectAll('*').interrupt(); root.replaceChildren(); }
    };
  };
})();
`;
