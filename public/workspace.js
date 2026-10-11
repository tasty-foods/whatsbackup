'use strict';
window.Workspace = (() => {
  const defaults = { uiTheme:'system', uiLayout:'grid', uiDensity:'comfortable', uiStartView:'overview', uiReduceMotion:false, uiVideoPreview:true, uiShowCaptions:true };
  let preferences = { ...defaults }, library = { favorites:[], views:[] }, favoriteIds = new Set(), selected = new Set();
  let selecting = false, toastTimer, dialogOpener = null, ready = false;
  const node = id => document.getElementById(id);
  const title = { overview:'Overview', media:'Library', convo:'Conversations', search:'Search & ask', topics:'Topics', finals:'Finals', status:'Status Studio', cleanup:'Clean up' };
  function toast(message) {
    const box = node('workspace-toast'); box.textContent = message; box.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.add('hidden'), 5500);
  }
  function applyPreferences(values) {
    if (!values) return;
    for (const key of Object.keys(defaults)) if (values[key] !== undefined) preferences[key] = values[key];
    const theme = preferences.uiTheme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preferences.uiTheme;
    const root = document.documentElement;
    root.dataset.theme = theme; root.dataset.layout = preferences.uiLayout; root.dataset.density = preferences.uiDensity;
    root.dataset.reduceMotion = String(preferences.uiReduceMotion); root.dataset.captions = String(preferences.uiShowCaptions);
    document.querySelectorAll('[data-layout]').forEach(button => {
      if (button === root) return;
      const active = button.dataset.layout === preferences.uiLayout;
      button.classList.toggle('active',active); button.setAttribute('aria-pressed',String(active));
    });
    for (const [key,value] of Object.entries(preferences)) {
      const input = node('set-'+key); if (!input) continue;
      if (input.type === 'checkbox') input.checked = !!value; else input.value = value;
    }
    if (!preferences.uiVideoPreview || preferences.uiReduceMotion) document.querySelectorAll('.tile-vid').forEach(video => video.pause());
    try { localStorage.setItem('whatsbackup-appearance',JSON.stringify(preferences)); } catch (_) {}
  }
  async function savePreferences(patch) {
    try {
      const result = await requestJson('/api/settings',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch) });
      applyPreferences(result.settings); return true;
    } catch (error) { applyPreferences(preferences); toast('Could not save appearance: '+error.message); return false; }
  }
  function setLibrary(data) {
    library = { favorites:data.favorites || [], views:data.views || [] }; favoriteIds = new Set(library.favorites);
    renderSavedViews(); if(F.favorite)render(allItems);else onRender();
  }
  function renderSavedViews() {
    const box=node('saved-views'); box.replaceChildren();
    if (!library.views.length) { box.innerHTML='<p>Your useful searches,<br>one click away.</p>'; return; }
    library.views.forEach(view => {
      const row=document.createElement('div');row.className='saved-view-row';
      const open=document.createElement('button');open.type='button';open.textContent=view.name;open.title=view.name;
      open.addEventListener('click',()=>{
        clearAll(); Object.assign(F,view.filters); els.search.value=F.q || '';
        if(node('content-scope'))node('content-scope').value=['all','content','names'].includes(F.contentScope)?F.contentScope:'all';
        const ids={exact:'f-exact',dir:'f-dir',album:'f-album',project:'f-project',tag:'f-tag',backup:'f-backup',from:'f-from',to:'f-to',sort:'f-sort'};
        Object.entries(ids).forEach(([key,id])=>{if(node(id))node(id).value=F[key]||'';});
        syncKindUi();renderSourceBar();setView('media');if(window.ContentSearch && F.q)window.ContentSearch.query(F.q);else render(allItems);
      });
      const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','Remove saved view '+view.name);
      remove.addEventListener('click',async()=>{
        try { setLibrary(await requestJson('/api/library/views/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:view.id})}));toast('Saved view removed. Your files are unchanged.'); }
        catch(error){toast('Could not remove view: '+error.message);}
      });row.append(open,remove);box.append(row);
    });
  }
  function onView(view) {
    node('workspace-title').textContent = view === 'media' && F.favorite ? 'Favourites' : title[view] || 'Overview';
    node('nav-favorites').classList.toggle('active',view==='media' && F.favorite);
    node('nav-favorites').setAttribute('aria-pressed',String(view==='media' && F.favorite));
    if(view==='media' && F.favorite) { const button=document.querySelector('#viewtoggle [data-v="media"]');button.classList.remove('active');button.setAttribute('aria-pressed','false'); }
  }
  function updateSelection() {
    document.body.classList.toggle('selecting',selecting);
    node('selection-bar').classList.toggle('hidden',!selecting);
    node('selection-count').textContent=selected.size+' selected';
    node('select-mode').setAttribute('aria-pressed',String(selecting));
    node('select-mode').textContent=selecting?'Selecting files':'Select files';
    node('selection-export').disabled=!selected.size;node('selection-favorite').disabled=!selected.size;
    document.querySelectorAll('.tile[data-id]').forEach(tile=>{
      const active=selected.has(tile.dataset.id);tile.classList.toggle('selected',active);
      const checkbox=tile.querySelector('.tile-select input');if(checkbox)checkbox.checked=active;
    });
  }
  function onRender() {
    node('library-count').textContent=filteredCache.length.toLocaleString()+(filteredCache.length===1?' item':' items');
    node('library-title').firstChild.textContent=F.favorite?'Your favourites ':'Your library ';
    node('nav-media-count').textContent=allItems.length.toLocaleString();
    node('favorites-count').textContent=allItems.filter(item=>favoriteIds.has(item.id)).length.toLocaleString();
    node('export-matching').disabled=!filteredCache.length;
    const records=new Map(allItems.map(item=>[item.id,item]));
    document.querySelectorAll('.tile[data-id]').forEach(el=>{const item=records.get(el.dataset.id);if(item)decorateTile(el,item);});
    updateSelection();onView(currentView);
  }
  async function favorite(ids,enabled) {
    try {
      const data=await requestJson('/api/library/favorites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,favorite:enabled})});
      setLibrary(data);
      toast(enabled?'Added to favourites.':'Removed from favourites.');return true;
    } catch(error){toast('Could not save favourites: '+error.message);return false;}
  }
  function decorateTile(el,item) {
    if(el.dataset.workspaceReady!=='1') {
      el.dataset.workspaceReady='1';
      const existing=[...el.childNodes];const open=document.createElement('a');open.className='tile-open';open.href=item.serve;
      open.setAttribute('aria-label','Preview '+(item.docName || item.chat || item.filename || 'media'));
      existing.forEach(child=>open.append(child));el.append(open);
      const copyState=document.createElement('span');copyState.className='tile-backup-state';copyState.textContent='PC only';copyState.title='On this PC only — not yet in your cloud folder';open.append(copyState);
      const info=document.createElement('div');info.className='tile-info';
      const name=document.createElement('b');name.textContent=item.docName || item.chat || 'Saved media';name.title=item.filename || item.docName || '';
      const meta=document.createElement('span'),type=document.createElement('span'),date=document.createElement('time');
      type.className='tile-chat';type.textContent=(SOURCES.find(source=>source.id===srcOf(item))||SOURCES[0]).label+' · '+({image:'Photo',video:'Video',...KIND_LABEL}[item.kind]||item.kind);
      date.dateTime=new Date(item.ts).toISOString();date.textContent=new Date(item.ts).toLocaleDateString([],{day:'numeric',month:'short'});
      meta.append(type,date);info.append(name,meta);el.append(info);
      const star=document.createElement('button');star.type='button';star.className='tile-favorite';
      star.addEventListener('click',async(event)=>{event.stopPropagation();star.disabled=true;await favorite([item.id],!favoriteIds.has(item.id));star.disabled=false;});el.append(star);
      const label=document.createElement('label');label.className='tile-select';
      const check=document.createElement('input');check.type='checkbox';check.setAttribute('aria-label','Select '+(item.docName||item.chat||'media'));
      label.append(check);label.addEventListener('click',event=>event.stopPropagation());
      check.addEventListener('change',()=>{selecting=true;check.checked?selected.add(item.id):selected.delete(item.id);updateSelection();});el.append(label);
    }
    const star=el.querySelector('.tile-favorite'),active=favoriteIds.has(item.id);
    star.textContent=active?'★':'☆';star.setAttribute('aria-pressed',String(active));star.setAttribute('aria-label',(active?'Remove from':'Add to')+' favourites');
    el.classList.toggle('selected',selected.has(item.id));
    el.querySelector('.tile-select input').checked=selected.has(item.id);
    el.querySelector('.tile-backup-state').hidden=!(typeof Backup!=='undefined' && Backup.configured() && Backup.onlyHere().has(item.id));
  }
  function viewer(item) {
    const button=document.createElement('button');button.type='button';button.className='lb-favorite';
    button.textContent=favoriteIds.has(item.id)?'★ Favourite':'☆ Add to favourites';button.setAttribute('aria-pressed',String(favoriteIds.has(item.id)));
    button.addEventListener('click',async()=>{button.disabled=true;if(await favorite([item.id],!favoriteIds.has(item.id))){button.textContent=favoriteIds.has(item.id)?'★ Favourite':'☆ Add to favourites';button.setAttribute('aria-pressed',String(favoriteIds.has(item.id)));}button.disabled=false;});els.lbMeta.append(button);
  }
  async function exportItems(items,button) {
    if(!items.length)return;
    if(items.length>10000){toast('Choose 10,000 files or fewer for one export.');return;}
    const original=button.textContent;button.disabled=true;button.textContent='Preparing…';
    try {
      const data=await requestJson('/api/export/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:items.map(item=>item.id)})});
      const link=document.createElement('a');link.href='/api/export/media?ticket='+encodeURIComponent(data.ticket);link.download='';document.body.append(link);link.click();link.remove();
      toast('Export prepared: '+items.length+' files. Your download is starting.');
    }catch(error){toast('Could not export: '+error.message);}
    finally{button.textContent=original;button.disabled=false;}
  }
  function openSaveView() {
    setView('media');dialogOpener=document.activeElement;node('save-view-dialog').classList.remove('hidden');node('save-view-name').value='';node('save-view-error').textContent='';node('save-view-name').focus();
  }
  function closeSaveView(){node('save-view-dialog').classList.add('hidden');requestAnimationFrame(()=>{if(dialogOpener?.isConnected && document.activeElement===document.body)dialogOpener.focus();});}
  node('save-view').addEventListener('click',openSaveView);node('save-view-shortcut').addEventListener('click',openSaveView);
  node('save-view-cancel').addEventListener('click',closeSaveView);
  node('save-view-dialog').addEventListener('click',event=>{if(event.target===node('save-view-dialog'))closeSaveView();});
  node('save-view-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter || node('save-view-form').querySelector('[type="submit"]');button.disabled=true;
    try {setLibrary(await requestJson('/api/library/views',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:node('save-view-name').value,filters:{...F}})}));closeSaveView();toast('View saved in your sidebar.');}
    catch(error){node('save-view-error').textContent=error.message;}finally{button.disabled=false;}
  });
  node('save-view-dialog').addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();closeSaveView();}
    if(event.key==='Tab'){
      const items=[...node('save-view-dialog').querySelectorAll('button,input')].filter(el=>!el.disabled);
      if(event.shiftKey && document.activeElement===items[0]){event.preventDefault();items.at(-1).focus();}
      else if(!event.shiftKey && document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}
    }
  });
  node('select-mode').addEventListener('click',()=>{selecting=!selecting;if(!selecting)selected.clear();updateSelection();});
  node('selection-clear').addEventListener('click',()=>{selecting=false;selected.clear();updateSelection();});
  node('select-all').addEventListener('click',()=>{filteredCache.forEach(item=>selected.add(item.id));updateSelection();});
  node('selection-favorite').addEventListener('click',async event=>{event.currentTarget.disabled=true;await favorite([...selected],true);updateSelection();});
  node('selection-export').addEventListener('click',event=>exportItems(allItems.filter(item=>selected.has(item.id)),event.currentTarget));
  node('export-matching').addEventListener('click',event=>exportItems(filteredCache,event.currentTarget));
  node('nav-favorites').addEventListener('click',()=>{clearAll();F.favorite=true;setView('media');render(allItems);});
  document.querySelector('[data-home]').addEventListener('click',event=>{event.preventDefault();setView('overview');});
  document.querySelectorAll('[data-settings-tab]').forEach(button=>button.addEventListener('click',()=>openSettingsTab(button.dataset.settingsTab)));
  document.querySelectorAll('.workspace-nav button,.sidebar-links button').forEach(button=>{
    button.setAttribute('aria-label',button.querySelector('span')?.textContent || button.textContent.trim());
    button.title=button.getAttribute('aria-label');
  });
  document.querySelectorAll('.layout-switch [data-layout]').forEach(button=>button.addEventListener('click',()=>savePreferences({uiLayout:button.dataset.layout})));
  els.search.addEventListener('input',()=>{if(currentView!=='media')setView('media');});
  document.addEventListener('keydown',event=>{
    if(!node('wizard').classList.contains('hidden') || !node('reels').classList.contains('hidden'))return;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();closeSaveView();closeSettings();if(!els.lightbox.classList.contains('hidden'))closeLightbox();queueMicrotask(()=>{els.search.focus();els.search.select();});}
    if((event.ctrlKey||event.metaKey)&&event.key===','){event.preventDefault();closeSaveView();if(!els.lightbox.classList.contains('hidden'))closeLightbox();openSettingsTab('appearance');}
  });
  const overlays=['settings','lightbox','save-view-dialog','wizard','reels'].map(node).filter(Boolean);
  const syncModal=()=>{
    const open=overlays.some(el=>!el.classList.contains('hidden'));
    node('workspace-content').inert=open;document.querySelector('.app-sidebar').inert=open;
    document.body.classList.toggle('workspace-modal-open',open);
  };
  const overlayObserver=new MutationObserver(syncModal);
  overlays.forEach(el=>overlayObserver.observe(el,{attributes:true,attributeFilter:['class']}));syncModal();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>applyPreferences(preferences));
  node('workspace-date').textContent=new Date().toLocaleDateString([],{weekday:'short',day:'numeric',month:'long'});
  try{applyPreferences({...defaults,...JSON.parse(localStorage.getItem('whatsbackup-appearance')||'{}')});}catch(_){applyPreferences(defaults);}
  async function init(){
    try {
      const [settings,data]=await Promise.all([requestJson('/api/settings'),requestJson('/api/library')]);
      applyPreferences(settings.settings);setLibrary(data);ready=true;
      if(currentView==='overview')setView(preferences.uiStartView);
    }catch(error){toast('Some workspace preferences could not load: '+error.message);}
  }
  init();
  return {toast,applyPreferences,onRender,onView,decorateTile,viewer,isFavorite:id=>favoriteIds.has(id),videoPreview:()=>preferences.uiVideoPreview&&!preferences.uiReduceMotion,ready:()=>ready};
})();
