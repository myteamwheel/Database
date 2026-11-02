// Position-constrained rotation planning. Listed positions establish eligible slots;
// an official game-specific Out status supplies a zero cap. Unknowns never become
// medical clearance. Convex costs minimize deviation from the supplied target MPG.
export const ROTATION_VERSION='rotation-position-flow-v1';
const SLOTS=['PG','SG','SF','PF','C'];
export function eligibleRotationSlots(position){
  if(typeof position!=='string')return [];
  const tokens=position.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const slots=new Set();
  for(const t of tokens){
    if(SLOTS.includes(t))slots.add(t);
    if(t==='G'||t==='GUARD'){slots.add('PG');slots.add('SG');}
    if(t==='F'||t==='FORWARD'){slots.add('SF');slots.add('PF');}
    if(t==='CENTER')slots.add('C');
  }
  return SLOTS.filter(s=>slots.has(s));
}
export function allocateRotation(players,{minutesPerSlot=48,ceiling=40,step=1}={}){
  if(!Array.isArray(players)||!players.length)throw new Error('Rotation requires players');
  if(![1,0.5].includes(step)||!Number.isFinite(minutesPerSlot)||minutesPerSlot<=0||!Number.isFinite(ceiling)||ceiling<=0||ceiling>48||minutesPerSlot/step%1)throw new Error('Invalid rotation bounds');
  const seen=new Set();
  const rows=players.map(p=>{
    if(!p||!['string','number'].includes(typeof p.id)||seen.has(String(p.id))||!Number.isFinite(p.target)||p.target<0)throw new Error('Invalid rotation identity or target');
    seen.add(String(p.id));
    const cap=p.out===true?0:Math.min(ceiling,p.maxMinutes??ceiling);
    if(!Number.isFinite(cap)||cap<0||!Number.isFinite(p.mobility??1)||(p.mobility??1)<=0)throw new Error('Invalid player rotation bounds');
    return {...p,id:String(p.id),cap,slots:eligibleRotationSlots(p.position)};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const source=0,slotStart=1+rows.length,sink=slotStart+5,n=sink+1,graph=Array.from({length:n},()=>[]);
  function edge(a,b,cap,cost){const x={to:b,cap,cost,rev:graph[b].length,initial:cap};const y={to:a,cap:0,cost:-cost,rev:graph[a].length,initial:0};graph[a].push(x);graph[b].push(y);return x;}
  const assignments=rows.map((p,i)=>{
    for(let k=1;k<=Math.floor(p.cap/step+1e-8);k++){
      const high=k*step,low=(k-1)*step;
      edge(source,i+1,1,((high-p.target)**2-(low-p.target)**2)/(p.mobility??1));
    }
    return Object.fromEntries(p.slots.map(slot=>[slot,edge(i+1,slotStart+SLOTS.indexOf(slot),Math.floor(p.cap/step+1e-8),0)]));
  });
  for(let j=0;j<5;j++)edge(slotStart+j,sink,minutesPerSlot/step,0);
  const required=5*minutesPerSlot/step;let flow=0;
  // Bellman-Ford on the residual network includes reverse edges: a flexible wing
  // can move slots when a constrained guard needs his place. Greedy fills cannot.
  while(flow<required){
    const dist=Array(n).fill(Infinity),prev=Array(n);dist[source]=0;
    for(let pass=0;pass<n-1;pass++){
      let changed=false;
      for(let v=0;v<n;v++)if(Number.isFinite(dist[v]))for(let ei=0;ei<graph[v].length;ei++){
        const e=graph[v][ei];
        if(e.cap>0&&dist[v]+e.cost<dist[e.to]-1e-9){dist[e.to]=dist[v]+e.cost;prev[e.to]=[v,ei];changed=true;}
      }
      if(!changed)break;
    }
    if(!prev[sink])break;
    for(let v=sink;v!==source;){const [u,ei]=prev[v],e=graph[u][ei];e.cap--;graph[v][e.rev].cap++;v=u;}
    flow++;
  }
  const allocated=rows.map((p,i)=>{const byPosition=Object.fromEntries(SLOTS.map(slot=>{const e=assignments[i][slot];return [slot,e?(e.initial-e.cap)*step:0];}));return {id:p.id,target:p.target,maxMinutes:p.cap,out:p.out===true,position:p.position??null,byPosition,minutes:Object.values(byPosition).reduce((a,b)=>a+b,0)};});
  const covered=Object.fromEntries(SLOTS.map(slot=>[slot,allocated.reduce((s,p)=>s+p.byPosition[slot],0)]));
  return {version:ROTATION_VERSION,status:flow===required?'feasible':'infeasible',step,requiredMinutes:5*minutesPerSlot,allocatedMinutes:flow*step,unfilledByPosition:Object.fromEntries(SLOTS.map(s=>[s,minutesPerSlot-covered[s]])),players:allocated,
    interpretation:'A feasible distribution of listed-position minutes closest to the supplied workload targets; not a prediction of lineup choices or proof of improved winning.'};
}
