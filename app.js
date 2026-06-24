// ---------- Auritech Mesh front-end ----------
let token = localStorage.getItem('am_token');
let me = null;
let chatTimer = null;
const root = document.getElementById('app');
const AURA_BLENDING = true; // ON = keep external light + clothes + background as aura colours; OFF = calibrated skin/hair/eyes only

const ENERGY = ['warmth','openness','intensity','groundedness','playfulness','depth','spark'];

async function api(path, opts = {}) {
  opts.headers = Object.assign({}, opts.headers);
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch('/api' + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
function esc(s){ return (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function grad(colors){ const c = (colors&&colors.length>=2)?colors:['#7c4dff','#ff6fb5']; return `linear-gradient(135deg,${c[0]},${c[1]})`; }
function avatar(u, size){
  const c = u.reading ? u.reading.auraColors : null;
  const initial = esc((u.name||'?')[0]);
  const img = u.photo ? `<img src="${u.photo}" loading="lazy" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : '';
  return `<div class="avatar" style="position:relative;overflow:hidden;width:${size}px;height:${size}px;background:${grad(c)};font-size:${Math.round(size*0.4)}px">${initial}${img}</div>`;
}
function pearson(a,b){const n=a.length;if(!n)return 0;const ma=a.reduce((x,y)=>x+y,0)/n,mb=b.reduce((x,y)=>x+y,0)/n;let nu=0,da=0,db=0;for(let i=0;i<n;i++){const x=a[i]-ma,y=b[i]-mb;nu+=x*y;da+=x*x;db+=y*y;}return(da&&db)?nu/Math.sqrt(da*db):0;}
function dualRow(c, sem){
  const second = sem ? {tag:'semantic', val:sem.development, op:.9} : {tag:'vibrancy', val:c.vibrancy, op:.5};
  return `<div class="chakra2">
    <div class="clab"><span class="cdot" style="background:${c.color}"></span><b>${esc(c.name)}</b>${sem&&sem.quality?`<span class="qual">${esc(sem.quality)}</span>`:''}</div>
    <div class="drow"><span class="dtag">color</span><div class="ctrack"><div class="cfill" style="width:${c.development}%;background:${c.color}"></div></div><span class="dval">${c.development}</span></div>
    <div class="drow"><span class="dtag">${second.tag}</span><div class="ctrack"><div class="cfill" style="width:${second.val}%;background:${c.color};opacity:${second.op}"></div></div><span class="dval">${second.val}</span></div>
  </div>`;
}
function auraDetail(r){
  const col=r.chakras||[], sem=r.chakrasSemantic||null, els=r.elements||[];
  let align='';
  if(sem&&sem.length){
    const rr=pearson(col.map(c=>c.development), sem.map(c=>c.development));
    const pct=Math.round((rr+1)/2*100);
    const v=rr>0.6?'strong alignment ✦':rr>0.3?'moderate alignment':rr>0?'weak alignment':'they diverge';
    align=`<div class="align"><b>Color ↔ Semantic alignment ${pct}%</b> <span class="muted">r=${rr.toFixed(2)} · ${v}</span></div>`;
  }
  return `
  ${col.length?`<div class="section"><h3>Chakra profile <span class="legend">${sem&&sem.length?'color (math) vs semantic (AI)':'development · vibrancy'}</span></h3>
    ${align}
    ${col.map((c,i)=>dualRow(c, (sem&&sem.length)?sem[i]:null)).join('')}
    ${(sem&&sem.length)?'':`<div class="muted hint">Semantic AI read is off — add your Claude key in Render to run the second method and compare.</div>`}
  </div>`:''}
  ${els.length?`<div class="section"><h3>Elemental balance <span class="legend">mastery · balance</span></h3>
    <div class="elements">${els.map(e=>`<div class="elem"><div class="eglyph">${e.glyph}</div><div class="ename">${esc(e.name)}</div><div class="etrack"><div class="efill" style="width:${e.mastery}%"></div></div><div class="etrack"><div class="efill alt" style="width:${e.balance}%"></div></div><div class="evals muted">${e.mastery} · ${e.balance}</div></div>`).join('')}</div>
  </div>`:''}`;
}

// ---- Professional head segmentation (MediaPipe Selfie Multiclass) ----
// Keeps only hair + body-skin + face-skin (incl. eyes); grays out clothes + background,
// so the colour math reads ONLY the person. Falls back to the full image if unavailable.
let _segmenter = null, _segReady = null;
function loadSegmenter(){
  if (_segmenter) return Promise.resolve(_segmenter);
  if (!_segReady) _segReady = (async () => {
    const v = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    const fileset = await v.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    _segmenter = await v.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite' },
      runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false });
    return _segmenter;
  })();
  return _segReady;
}
async function segmentHead(file){
  try{
    const seg = await loadSegmenter();
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 512 / Math.max(img.width, img.height));
    const cw = Math.max(1, Math.round(img.width * scale)), ch = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, cw, ch);
    const res = seg.segment(canvas);
    const mask = res.categoryMask, mw = mask.width, mh = mask.height, md = mask.getAsUint8Array();
    const id = ctx.getImageData(0, 0, cw, ch), d = id.data; let kept = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const cat = md[Math.min(mh-1,(y*mh/ch)|0)*mw + Math.min(mw-1,(x*mw/cw)|0)];
      if (cat===1 || cat===2 || cat===3) kept++;            // hair, body-skin, face-skin
      else { const p=(y*cw+x)*4; d[p]=128; d[p+1]=128; d[p+2]=128; }  // gray out clothes + background
    }
    mask.close();
    if (kept < cw*ch*0.02) return file;                      // found ~nothing -> use full image
    ctx.putImageData(id, 0, 0);
    return await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
  } catch(e){ console.warn('head segmentation unavailable, using full image:', e); return file; }
}

function boot(){
  if (!token) return renderAuth('login');
  api('/me').then(({user}) => { me = user; me.reading ? renderMain('discover') : renderOnboarding(); })
            .catch(() => { token=null; localStorage.removeItem('am_token'); renderAuth('login'); });
}

// ---------- AUTH ----------
function renderAuth(mode){
  root.innerHTML = `
  <div class="screen center fade">
    <div class="brand">Auritech Mesh</div>
    <div class="tag">Match by the colors of your aura ✦</div>
    <div style="width:100%;max-width:340px">
      ${mode==='signup' ? `<input class="field" id="name" placeholder="First name" />` : ``}
      <input class="field" id="email" type="email" placeholder="Email" autocomplete="email" />
      <input class="field" id="password" type="password" placeholder="Password" autocomplete="current-password" />
      <div class="err" id="err"></div>
      <button class="btn" id="go">${mode==='signup'?'Create account':'Log in'}</button>
      <button class="btn ghost" id="toggle">${mode==='signup'?'I already have an account':"New here? Create an account"}</button>
    </div>
  </div>`;
  document.getElementById('toggle').onclick = () => renderAuth(mode==='signup'?'login':'signup');
  document.getElementById('go').onclick = async () => {
    const err = document.getElementById('err'); err.textContent='';
    const body = { email: val('email'), password: val('password') };
    if (mode==='signup') body.name = val('name');
    try{
      const { token:t, user } = await api('/auth/'+(mode==='signup'?'signup':'login'), { method:'POST', body });
      token=t; localStorage.setItem('am_token',t); me=user;
      me.reading ? renderMain('discover') : renderOnboarding();
    }catch(e){ err.textContent = e.message; }
  };
}
const val = id => document.getElementById(id).value.trim();

// ---------- ONBOARDING ----------
function renderOnboarding(){
  root.innerHTML = `
  <div class="screen fade">
    <div class="brand" style="font-size:24px">Welcome, ${esc(me.name)}</div>
    <p class="muted">A few details, then we scan your aura.</p>
    <label class="lbl">Age</label>
    <input class="field" id="age" type="number" inputmode="numeric" value="${me.age||''}" placeholder="Your age" />
    <label class="lbl">I am a</label>
    <select class="field" id="gender">
      ${opt(me.gender,['woman','man','nonbinary'])}
    </select>
    <label class="lbl">Show me</label>
    <select class="field" id="seeking">
      ${opt(me.seeking,['everyone','woman','man','nonbinary'])}
    </select>
    <label class="lbl">Bio</label>
    <textarea class="field" id="bio" rows="2" placeholder="A line about you">${esc(me.bio||'')}</textarea>
    <div class="err" id="err"></div>
    <button class="btn" id="next">Continue to aura scan →</button>
  </div>`;
  document.getElementById('next').onclick = async () => {
    try{
      await api('/me',{method:'PATCH',body:{ age:Number(document.getElementById('age').value)||null, gender:val('gender'), seeking:val('seeking'), bio:document.getElementById('bio').value.trim() }});
      renderScan();
    }catch(e){ document.getElementById('err').textContent=e.message; }
  };
}
function opt(cur,arr){ return arr.map(v=>`<option ${cur===v?'selected':''} value="${v}">${v[0].toUpperCase()+v.slice(1)}</option>`).join(''); }

function renderScan(){
  root.innerHTML = `
  <div class="screen scanwrap fade">
    <h2>Aura scan</h2>
    <p class="muted">Upload a clear selfie. Our engine reads your energy field.</p>
    <div class="scancircle" id="circle"><span class="muted" id="ph">No photo yet</span></div>
    <input type="file" id="file" accept="image/*" capture="user" class="hidden" />
    <button class="btn alt" id="choose">📷 Choose selfie</button>
    <button class="btn" id="scan" disabled style="opacity:.5">Scan my aura</button>
    <div class="err" id="err"></div>
  </div>`;
  const file=document.getElementById('file'), circle=document.getElementById('circle'), scanBtn=document.getElementById('scan');
  document.getElementById('choose').onclick = () => file.click();
  file.onchange = () => {
    if(!file.files[0]) return;
    const url=URL.createObjectURL(file.files[0]);
    circle.innerHTML = `<img src="${url}" />`;
    scanBtn.disabled=false; scanBtn.style.opacity=1;
  };
  scanBtn.onclick = async () => {
    if(!file.files[0]) return;
    circle.innerHTML += `<div class="scanline"></div>`;
    scanBtn.disabled=true; scanBtn.classList.add('spin');
    let cutout;
    if(AURA_BLENDING){ scanBtn.textContent='Blending your aura…'; cutout=file.files[0]; }
    else { scanBtn.textContent='Isolating skin, hair & eyes…'; cutout=await segmentHead(file.files[0]); }
    scanBtn.textContent='Reading your aura…';
    const fd=new FormData(); fd.append('blend', AURA_BLENDING?'on':'off'); fd.append('photo', cutout);
    try{
      const { user } = await api('/scan',{method:'POST',body:fd});
      me=user; revealReading(me.reading, ()=>renderMain('discover'));
    }catch(e){ document.getElementById('err').textContent=e.message; scanBtn.textContent='Scan my aura'; scanBtn.disabled=false; scanBtn.classList.remove('spin'); }
  };
}

function revealReading(r, done){
  root.innerHTML = `
  <div class="screen center fade">
    <div class="bigaura" style="background:${grad(r.auraColors)}"></div>
    <div class="brand" style="font-size:24px">${esc(r.auraName)}</div>
    <div class="auraName">${esc(r.headline||'')}</div>
    <p class="muted" style="margin-top:10px">${esc(r.summary||'')}</p>
    <div style="margin:6px 0">${(r.personality||[]).map(t=>`<span class="chip">${esc(t)}</span>`).join('')}</div>
    <div style="width:100%;text-align:left">${auraDetail(r)}</div>
    <button class="btn" id="done">Enter Auritech Mesh →</button>
  </div>`;
  document.getElementById('done').onclick = done;
}

// ---------- MAIN SHELL ----------
function renderMain(tab){
  if(chatTimer){ clearInterval(chatTimer); chatTimer=null; }
  root.innerHTML = `
    <div class="topbar"><div class="brand">Auritech Mesh</div><div>${avatar(me,34)}</div></div>
    <div id="view" style="flex:1;display:flex;flex-direction:column;overflow:hidden"></div>
    <div class="nav">
      <button data-t="discover"><span class="ic">✦</span>Discover</button>
      <button data-t="matches"><span class="ic">♥</span>Matches</button>
      <button data-t="profile"><span class="ic">◍</span>Aura</button>
    </div>`;
  root.querySelectorAll('.nav button').forEach(b=>{
    b.classList.toggle('active', b.dataset.t===tab);
    b.onclick=()=>renderMain(b.dataset.t);
  });
  ({discover:renderDiscover, matches:renderMatches, profile:renderProfile}[tab])();
}
const view = () => document.getElementById('view');

// ---------- DISCOVER ----------
async function renderDiscover(){
  view().innerHTML = `<div class="screen center"><span class="muted spin">Reading the room…</span></div>`;
  let list=[];
  try{ list=(await api('/discover')).candidates; }catch(e){}
  const v=view();
  if(!list.length){ v.innerHTML=`<div class="screen center"><h3>No new auras nearby</h3><p class="muted">Come back soon — new people glow in all the time.</p></div>`; return; }
  let i=0;
  function show(){
    if(i>=list.length){ v.innerHTML=`<div class="screen center"><h3>That's everyone for now ✦</h3><p class="muted">Check your matches.</p></div>`; return; }
    const u=list[i];
    v.innerHTML=`
      <div class="deck">
        <div class="card fade">
          <div class="reso"><b>${u.resonance||'—'}%</b><span>resonance</span></div>
          <div class="hero">
            <div class="heroGrad" style="background:${grad(u.reading.auraColors)}"></div>${u.photo?`<img src="${u.photo}" loading="lazy" onerror="this.remove()"/>`:''}
            <div class="meta">
              <div class="name">${esc(u.name)}${u.age?`, ${u.age}`:''}</div>
              <div class="auraName">${esc(u.reading.auraName)}</div>
              <p class="muted" style="margin:8px 0 0">${esc(u.bio||u.reading.headline||'')}</p>
              <div style="margin-top:6px">${(u.reading.personality||[]).slice(0,4).map(t=>`<span class="chip">${esc(t)}</span>`).join('')}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="deckBtns">
        <button class="circbtn pass" id="pass">✕</button>
        <button class="circbtn like" id="like">♥</button>
      </div>`;
    v.querySelector('#pass').onclick=()=>act('pass');
    v.querySelector('#like').onclick=()=>act('like');
  }
  async function act(action){
    const u=list[i];
    try{ const res=await api('/like',{method:'POST',body:{targetId:u.id,action}}); if(res.matched) return showMatch(res.match,()=>{ i++; show(); }); }catch(e){}
    i++; show();
  }
  show();
}

function showMatch(u, cont){
  const o=document.createElement('div'); o.className='overlay fade';
  o.innerHTML=`<div class="big">It's a resonance ✦</div>
    <p class="muted">You and ${esc(u.name)} are ${u.resonance||''}% aligned.</p>
    <div style="margin:18px 0">${avatar(me,72)} ${avatar(u,72)}</div>
    <button class="btn" id="chat">Send a message</button>
    <button class="btn ghost" id="keep">Keep browsing</button>`;
  root.appendChild(o);
  o.querySelector('#keep').onclick=()=>{ o.remove(); cont&&cont(); };
  o.querySelector('#chat').onclick=()=>{ o.remove(); renderChat(u); };
}

// ---------- MATCHES ----------
async function renderMatches(){
  view().innerHTML=`<div class="screen"><h2 style="margin-bottom:6px">Your matches</h2><div id="ml"><span class="muted spin">Loading…</span></div></div>`;
  let matches=[]; try{ matches=(await api('/matches')).matches; }catch(e){}
  const ml=document.getElementById('ml');
  if(!matches.length){ ml.innerHTML=`<p class="muted">No matches yet — like a few auras in Discover.</p>`; return; }
  ml.innerHTML='';
  matches.forEach(u=>{
    const d=document.createElement('div'); d.className='listitem';
    d.innerHTML=`${avatar(u,54)}<div><div class="name">${esc(u.name)} <span class="muted">${u.resonance||''}%</span></div><div class="last">${esc(u.lastMessage||u.reading.auraName)}</div></div>`;
    d.onclick=()=>renderChat(u); ml.appendChild(d);
  });
}

// ---------- PROFILE ----------
function renderProfile(){
  const r=me.reading;
  view().innerHTML=`
  <div class="screen fade">
    <div class="bigaura" style="background:${grad(r.auraColors)}"></div>
    <h2 style="text-align:center">${esc(me.name)}${me.age?`, ${me.age}`:''}</h2>
    <div class="auraName" style="text-align:center">${esc(r.auraName)}</div>
    <div class="section"><h3>Aura reading</h3><p style="margin:8px 0 0">${esc(r.summary||'')}</p>
      <div style="margin-top:8px">${(r.personality||[]).map(t=>`<span class="chip">${esc(t)}</span>`).join('')}</div></div>
    <div class="section"><h3>Love style</h3><p style="margin:8px 0 0">${esc(r.loveStyle||'')}</p></div>
    ${auraDetail(r)}
    <button class="btn alt" id="rescan">Re-scan my aura</button>
    <button class="btn ghost" id="logout">Log out</button>
  </div>`;
  document.getElementById('rescan').onclick=()=>renderScan();
  document.getElementById('logout').onclick=()=>{ token=null; localStorage.removeItem('am_token'); me=null; renderAuth('login'); };
}

// ---------- CHAT ----------
function renderChat(u){
  if(chatTimer){ clearInterval(chatTimer); }
  root.innerHTML=`
    <div class="topbar"><button class="btn ghost" style="width:auto;margin:0" id="back">‹ Back</button>
      <div style="display:flex;align-items:center;gap:8px">${avatar(u,30)}<b>${esc(u.name)}</b></div><div style="width:40px"></div></div>
    <div class="chat"><div class="msgs" id="msgs"></div>
      <div class="composer"><input id="text" placeholder="Say something to ${esc(u.name)}…" /><button id="send">➤</button></div></div>`;
  document.getElementById('back').onclick=()=>renderMain('matches');
  async function load(){
    try{
      const { messages }=await api('/messages/'+u.id);
      const box=document.getElementById('msgs'); if(!box) return;
      box.innerHTML=messages.map(m=>`<div class="bubble ${m.mine?'me':'them'}">${esc(m.text)}</div>`).join('') ||
        `<p class="muted" style="text-align:center;margin-top:30px">You matched at ${u.resonance||''}% — say hi ✦</p>`;
      box.scrollTop=box.scrollHeight;
    }catch(e){}
  }
  async function send(){
    const t=document.getElementById('text'); const text=t.value.trim(); if(!text) return; t.value='';
    try{ await api('/messages',{method:'POST',body:{to:u.id,text}}); await load(); }catch(e){}
  }
  document.getElementById('send').onclick=send;
  document.getElementById('text').addEventListener('keydown',e=>{ if(e.key==='Enter') send(); });
  load(); chatTimer=setInterval(load,3500);
}

boot();
