const state = { words: [], current: 0, view: 'learn', query: '', level: 'all', chapterLevel: 'A1', progress: {}, activeChapter: null, testIndex: 0, testMode: 'random', testChapter: '', testHistory: [], testStarted: false, testQueue: [], testPosition: -1, testExampleWords: false, showExampleText: true, audioRate: 1 };
const $ = id => document.getElementById(id);
const DAY = 86400000;
const PROGRESS_KEY = 'lexi-progress';
const PROGRESS_BACKUP_KEY = 'koko-okok-progress-backup';
let activeAudio=null,activeAudioUrl=null,activeAudioController=null,activeUtterance=null,audioGeneration=0,testAudioTimer=null;
const audioChannel='BroadcastChannel'in window?new BroadcastChannel('koko-okok-audio-control'):null;

async function loadProgress(){
  let local={};try{local=JSON.parse(localStorage.getItem(PROGRESS_KEY)||localStorage.getItem(PROGRESS_BACKUP_KEY)||'{}')}catch{}
  let shared={};try{const response=await fetch('/api/progress',{cache:'no-store'});if(response.ok)shared=await response.json()}catch{}
  const merged={...shared};Object.entries(local).forEach(([id,record])=>{const existing=merged[id];if(!existing||(record.last||0)>=(existing.last||0))merged[id]=record});
  const saved=JSON.stringify(merged);localStorage.setItem(PROGRESS_KEY,saved);localStorage.setItem(PROGRESS_BACKUP_KEY,saved);return merged;
}
function syncProgressNow(){
  const data=JSON.stringify(state.progress);localStorage.setItem(PROGRESS_KEY,data);localStorage.setItem(PROGRESS_BACKUP_KEY,data);fetch('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:data,keepalive:true}).catch(()=>{});
}
function saveProgress(){const data=JSON.stringify(state.progress);localStorage.setItem(PROGRESS_KEY,data);localStorage.setItem(PROGRESS_BACKUP_KEY,data);clearTimeout(saveProgress.timer);saveProgress.timer=setTimeout(syncProgressNow,220);updateStats()}
function recordFor(id){ return state.progress[id] || (state.progress[id]={stars:0,status:'new',due:0,repetitions:0,last:0}); }
function hasSenseStars(record){return Object.values(record.senseStars||{}).some(Boolean)}
function currentWord(){ return state.words[state.current]; }
function renderStarRating(containerId,word){
  const container=$(containerId),rec=recordFor(word.id),labels=['Slightly unfamiliar','Unfamiliar','Very unfamiliar'];
  container.innerHTML=[1,2,3].map(value=>`<button type="button" class="${value<=rec.stars?'filled':''}" data-star-value="${value}" aria-label="${labels[value-1]}" title="${labels[value-1]}">${value<=rec.stars?'★':'☆'}</button>`).join('');
  container.querySelectorAll('[data-star-value]').forEach(button=>button.onclick=()=>{const value=+button.dataset.starValue,next=rec.stars===value?0:value;rec.stars=next;rec.inWordbook=next>0||hasSenseStars(rec);if(next){rec.status='learning';rec.due=rec.due||Date.now()}else if(rec.status==='learning'&&!hasSenseStars(rec)){rec.status='new';rec.due=0}saveProgress();renderStarRating(containerId,word);toast(next?`Unfamiliarity: ${'★'.repeat(next)}${'☆'.repeat(3-next)}`:'Unfamiliarity cleared')});
}
function chapterKey(word){return `${word.level}|||${word.category}`}
function studyIndices(){const indexes=state.words.map((w,i)=>state.activeChapter===null||chapterKey(w)===state.activeChapter?i:-1).filter(i=>i>=0);return indexes.length?indexes:state.words.map((_,i)=>i)}
function orderedChapterKeys(){const levels=['A1','A2','B1','B2'];return [...new Set(state.words.map(chapterKey))].sort((a,b)=>{const [al,ac]=a.split('|||'),[bl,bc]=b.split('|||');return levels.indexOf(al)-levels.indexOf(bl)||ac.localeCompare(bc)})}
function toast(message){ const el=$('toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),1900); }
function stopAudio(){audioGeneration++;clearTimeout(testAudioTimer);testAudioTimer=null;if(activeAudioController){activeAudioController.abort();activeAudioController=null}if(activeAudio){activeAudio.pause();activeAudio.removeAttribute('src');activeAudio=null}if(activeAudioUrl){URL.revokeObjectURL(activeAudioUrl);activeAudioUrl=null}activeUtterance=null;if('speechSynthesis'in window){speechSynthesis.cancel();speechSynthesis.resume()}}
function claimAudio(){audioChannel?.postMessage('stop');stopAudio()}
audioChannel?.addEventListener('message',stopAudio);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAudio()});
window.addEventListener('pagehide',stopAudio);
function cleanSelectedWord(text){const match=String(text||'').trim().match(/[A-Za-z]+(?:['’-][A-Za-z]+)?/);return match?match[0].replace('’',"'"):''}
function localLookup(term){
  const lower=term.toLowerCase();const forms=[lower,lower.replace(/'s$/,''),lower.replace(/ies$/,'y'),lower.replace(/ing$/,''),lower.replace(/ed$/,''),lower.replace(/s$/,'')];
  const found=state.words.find(w=>forms.includes(w.word.toLowerCase()));
  return found?found.senses.slice(0,4).map(s=>({partOfSpeech:s.label||found.grammar||found.pos,definition:s.definition,example:s.example})):null;
}
async function showLookup(term,rect){
  const pop=$('lookupPopover');$('lookupWord').textContent=term;$('lookupSpeak').onclick=()=>speakWord(term);$('lookupBody').innerHTML='<p class="lookup-loading">Looking for a clear English meaning…</p>';
  const width=Math.min(390,window.innerWidth-28),left=Math.min(window.innerWidth-width-14,Math.max(14,rect.left+rect.width/2-width/2));const below=rect.bottom+12;pop.style.left=`${left}px`;pop.style.top=`${below+420>window.innerHeight?Math.max(14,rect.top-430):below}px`;pop.classList.add('open');
  let entries=localLookup(term);
  if(!entries){try{const response=await fetch(`/api/lookup?word=${encodeURIComponent(term)}`);if(response.ok)entries=await response.json()}catch{entries=null}}
  $('lookupBody').innerHTML=entries?.length?entries.slice(0,5).map(e=>`<div class="lookup-entry"><span class="lookup-pos">${escapeHtml(e.partOfSpeech||'word')}</span><p class="lookup-definition">${escapeHtml(e.definition)}</p>${e.example?`<p class="lookup-example">“${escapeHtml(e.example)}”</p>`:''}</div>`).join(''):'<p class="lookup-error">No English definition was found for this selection.</p>';
}
function handleTextSelection(){
  const selection=window.getSelection();if(!selection||selection.isCollapsed)return;const term=cleanSelectedWord(selection.toString());if(!term||term.length>35)return;
  const anchor=selection.anchorNode?.parentElement;if(!anchor?.closest('.sense, .lookup-popover'))return;const rect=selection.getRangeAt(0).getBoundingClientRect();showLookup(term,rect);
}

function renderWord(autoPlay=true){
  stopAudio();const word=currentWord(); if(!word)return;
  const rec=recordFor(word.id);
  $('wordText').textContent=cleanHeadword(word); $('posText').textContent=word.grammar||`${word.pos} ${word.level}`; $('levelPill').textContent=word.level; $('categoryText').textContent=word.category;
  const indexes=studyIndices(),position=Math.max(0,indexes.indexOf(state.current));$('studyCounter').textContent=state.activeChapter?`Chapter progress · ${position+1} / ${indexes.length}`:`All words · ${position+1} / ${indexes.length}`;
  renderStarRating('learnStars',word);
  $('toggleExamples').textContent=state.showExampleText?'Hide all text':'Show all text';
  $('senses').innerHTML=word.senses.map((s,i)=>`<div class="sense"><div class="sense-head"><span class="sense-label">${escapeHtml(s.label||word.pos)}</span></div><div class="sense-definition-row"><p>${escapeHtml(s.definition)}</p><span class="sense-actions"><button type="button" class="sense-star ${rec.senseStars?.[i]?'filled':''}" data-sense-star="${i}" aria-label="Mark this meaning as unfamiliar" title="Mark this meaning as unfamiliar">${rec.senseStars?.[i]?'★':'☆'}</button><button class="speak-button" data-sense="definition" data-index="${i}" aria-label="Hear definition"></button></span></div>${s.example?`<div class="example-block"><p class="example"><span class="example-copy">${state.showExampleText?`“${escapeHtml(s.example)}”`:'Sentence text hidden — play the example.'}</span><span class="example-actions"><button class="speak-button" data-sense="example" data-index="${i}" aria-label="Hear example"></button></span></p></div>`:''}</div>`).join('');
  $('senses').querySelectorAll('[data-sense-star]').forEach(button=>button.onclick=()=>{const index=button.dataset.senseStar;rec.senseStars={...(rec.senseStars||{}),[index]:!rec.senseStars?.[index]};if(!rec.senseStars[index])delete rec.senseStars[index];rec.inWordbook=rec.stars>0||hasSenseStars(rec);if(rec.senseStars[index]){rec.status='learning';rec.due=rec.due||Date.now()}else if(!rec.inWordbook&&rec.status==='learning'){rec.status='new';rec.due=0}button.classList.toggle('filled',!!rec.senseStars[index]);button.textContent=rec.senseStars[index]?'★':'☆';saveProgress();toast(rec.senseStars[index]?'Meaning added to Wordbook':'Meaning removed from Wordbook')});
  $('senses').querySelectorAll('[data-sense]').forEach(b=>{const index=+b.dataset.index,kind=b.dataset.sense;b.onclick=()=>speak(word.senses[index][kind])});
  const now=Date.now();recordFor(word.id).last=now;state.progress.__settings={...(state.progress.__settings||{}),lastWordId:word.id,last:now};saveProgress();window.scrollTo({top:0,behavior:'smooth'});if(autoPlay)testAudioTimer=setTimeout(()=>{testAudioTimer=null;if(state.view==='learn'&&currentWord()?.id===word.id)speakWord(word)},120);
}
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function cleanHeadword(value){return String(value?.word??value??'').replace(/\d+$/,'').trim()}
function speakWord(value){return speak(`${cleanHeadword(value)}.`,Math.min(state.audioRate,0.88))}
function isMobileDevice(){return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&window.innerWidth<900)}
function preferredVoice(){const voices=speechSynthesis.getVoices(),american=voices.filter(v=>/^en-US$/i.test(v.lang)),english=voices.filter(v=>/^en(?:-|_)/i.test(v.lang));if(isMobileDevice()){return american.find(v=>/^Samantha$/i.test(v.name))||american.find(v=>/Google US English.*Female|Google.*US.*Female/i.test(v.name))||american.find(v=>/Google US English/i.test(v.name))||american.find(v=>/Jenny/i.test(v.name))||american.find(v=>/Aria/i.test(v.name))||american.find(v=>/Ava|Emma|Michelle|Zira|Susan|Victoria|Female/i.test(v.name))||american[0]||english.find(v=>/Samantha|Google.*Female|Jenny|Aria|Ava|Emma|Michelle|Zira|Susan|Victoria|Female/i.test(v.name))||english[0]||null}return voices.find(v=>/^Microsoft Andrew Online \(Natural\)/i.test(v.name)||/AndrewNeural/i.test(v.name))||voices.find(v=>/Andrew/i.test(v.name)&&!/Multilingual/i.test(v.name))||american.find(v=>/Christopher|Guy|David|Eric|Mark|Roger|Alex|Nathan|Matthew|Aaron|Fred|Ralph|Daniel|Male/i.test(v.name))||american[0]||english[0]||null}
function speak(text,rate=state.audioRate){if(!text||!('speechSynthesis'in window))return;claimAudio();const generation=audioGeneration,started=Date.now(),play=()=>{if(generation!==audioGeneration)return;const voice=preferredVoice(),voicesReady=speechSynthesis.getVoices().length>0;if(!voicesReady&&Date.now()-started<1800){setTimeout(play,150);return}const u=new SpeechSynthesisUtterance(text);u.lang='en-US';u.rate=rate;if(voice)u.voice=voice;activeUtterance=u;u.onend=()=>{if(generation===audioGeneration)activeUtterance=null};u.onerror=()=>{if(generation===audioGeneration)activeUtterance=null};speechSynthesis.speak(u)};play()}
function addCurrentToWordbook(){
  const rec=recordFor(currentWord().id);rec.stars=Math.max(1,rec.stars);rec.status='learning';rec.inWordbook=true;rec.due=rec.due||Date.now();saveProgress();renderWord(false);toast('Added to Wordbook');
}
function markCurrentMastered(){rate('easy')}
function rate(kind){
  const word=currentWord(),rec=recordFor(word.id),now=Date.now();rec.repetitions++;rec.last=now;
  if(kind==='again'){rec.status='learning';rec.inWordbook=true;rec.stars=Math.max(rec.stars,3);rec.due=now+10*60000}
  if(kind==='hard'){rec.status='learning';rec.inWordbook=true;rec.stars=Math.max(rec.stars,2);rec.due=now+DAY}
  if(kind==='good'){rec.status='learning';rec.inWordbook=true;rec.stars=Math.max(rec.stars,1);rec.due=now+DAY*Math.min(30,3*Math.max(1,rec.repetitions))}
  if(kind==='easy'){rec.status='mastered';rec.inWordbook=false;rec.stars=0;rec.due=now+DAY*30}
  saveProgress();toast(kind==='easy'?'Moved to Mastered':`Review scheduled: ${kind}`);nextWord();
}
function nextWord(){const indexes=studyIndices(),place=indexes.indexOf(state.current);if(state.activeChapter!==null&&place===indexes.length-1){const chapters=orderedChapterKeys(),chapterPosition=chapters.indexOf(state.activeChapter),nextChapter=chapters[chapterPosition+1];if(!nextChapter){toast('Course complete — you finished the final chapter.');return}const [level,category]=nextChapter.split('|||');if(!window.confirm(`Chapter complete. Continue to the next chapter: ${level} · ${category}?`))return;state.activeChapter=nextChapter;const nextIndexes=studyIndices(),unseen=nextIndexes.find(i=>state.progress[state.words[i].id]?.status!=='mastered');state.current=unseen??nextIndexes[0];renderWord();toast(`Next chapter: ${level} · ${category}`);return}state.current=indexes[(place+1+indexes.length)%indexes.length];renderWord()}
function previousWord(){const indexes=studyIndices(),place=indexes.indexOf(state.current);state.current=indexes[(place-1+indexes.length)%indexes.length];renderWord()}
function testAudioText(word){const headword=cleanHeadword(word),example=word.senses.find(s=>s.example)?.example||'';return example?`${headword}. ${example}`:headword}
function playTestAudio(word){if(!('speechSynthesis'in window))return;claimAudio();const generation=audioGeneration,exampleIndex=word.senses.findIndex(s=>s.example),items=[`${cleanHeadword(word)}.`];if(exampleIndex>=0)items.push(word.senses[exampleIndex].example);const started=Date.now(),begin=()=>{if(generation!==audioGeneration)return;const voice=preferredVoice(),voicesReady=speechSynthesis.getVoices().length>0;if(!voicesReady&&Date.now()-started<1800){setTimeout(begin,150);return}const playAt=index=>{if(index>=items.length||generation!==audioGeneration)return;const u=new SpeechSynthesisUtterance(items[index]);u.lang='en-US';u.rate=index===0?Math.min(state.audioRate,0.88):state.audioRate;if(voice)u.voice=voice;activeUtterance=u;u.onend=()=>{if(generation!==audioGeneration)return;activeUtterance=null;playAt(index+1)};u.onerror=()=>{if(generation!==audioGeneration)return;activeUtterance=null};speechSynthesis.speak(u)};playAt(0)};begin()}
function normalizeSentence(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'')}
function testPool(){let pool=state.words.map((w,i)=>state.testMode==='chapter'&&state.testChapter&&chapterKey(w)!==state.testChapter?-1:i).filter(i=>i>=0);const learning=pool.filter(i=>state.progress[state.words[i].id]?.status!=='mastered');return learning.length?learning:pool}
function buildTestSession(){
  const shuffled=[...testPool()];for(let i=shuffled.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]}state.testQueue=state.testMode==='random'?shuffled.slice(0,20):shuffled;state.testPosition=-1;state.testHistory=[];state.testStarted=false;nextTestWord();
}
function nextTestWord(){
  stopAudio();$('testContinue').hidden=true;if(!state.testQueue.length){buildTestSession();return}if(state.testStarted){state.testHistory.push({index:state.testIndex,position:state.testPosition});if(state.testHistory.length>100)state.testHistory.shift()}state.testPosition++;if(state.testPosition>=state.testQueue.length){$('testCounter').textContent=`${state.testQueue.length} / ${state.testQueue.length}`;$('testFeedback').className='test-feedback correct';$('testFeedback').textContent=`Test complete — ${state.testQueue.length} words.`;$('testAnswer').value='';$('testAnswer').disabled=true;return}state.testIndex=state.testQueue[state.testPosition];state.testStarted=true;state.testExampleWords=false;$('testAnswer').disabled=false;$('testAnswer').value='';$('testCounter').textContent=`${state.testPosition+1} / ${state.testQueue.length}`;$('testFeedback').className='test-feedback';$('testFeedback').textContent='';renderTestHint();renderStarRating('testStars',state.words[state.testIndex]);testAudioTimer=setTimeout(()=>{testAudioTimer=null;playTestAudio(state.words[state.testIndex]);$('testAnswer').focus()},120);
}
function previousTestWord(){
  if(!state.testHistory.length){toast('No previous test word yet');return}$('testContinue').hidden=true;const previous=state.testHistory.pop();state.testIndex=previous.index;state.testPosition=previous.position;const word=state.words[state.testIndex],headword=cleanHeadword(word);$('testAnswer').disabled=false;$('testAnswer').value=headword;$('testCounter').textContent=`${state.testPosition+1} / ${state.testQueue.length}`;renderTestHint();renderStarRating('testStars',word);$('testFeedback').className='test-feedback';$('testFeedback').innerHTML=`Previous word: <strong>${escapeHtml(headword)}</strong>`;playTestAudio(word);$('testAnswer').focus();$('testAnswer').select();
}
function clozeExample(example,word){if(state.testExampleWords)return example;const escaped=word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return example.replace(new RegExp(`\\b${escaped}(?:s|es|d|ed|ing|ies)?\\b`,'gi'),'______')}
function renderTestHint(){
  const word=state.words[state.testIndex],showHint=$('testHintToggle').checked,examples=word.senses.map((s,index)=>({...s,index})).filter(s=>s.example);$('testSentenceList').innerHTML=examples.map(s=>`<section class="test-sentence-row"><div class="test-sentence-row-head"><div><span>${escapeHtml(s.label||word.pos)}</span>${showHint?`<p>${escapeHtml(s.definition)}</p>`:''}</div><div><button class="speak-button" data-test-example-play="${s.index}" aria-label="Play this example"></button><button class="hint-word-button" data-test-example-reveal="${s.index}" type="button">Show sentence</button></div></div><p class="test-example-text" data-test-example-text="${s.index}" hidden>“${escapeHtml(s.example)}”</p><form data-test-example-form="${s.index}"><input type="text" autocomplete="off" spellcheck="false" placeholder="Type the complete sentence"/><button class="secondary-button" type="submit">Check</button><small></small></form></section>`).join('');
  $('testSentenceList').querySelectorAll('[data-test-example-play]').forEach(button=>{const index=+button.dataset.testExamplePlay;button.onclick=()=>speak(word.senses[index].example)});$('testSentenceList').querySelectorAll('[data-test-example-reveal]').forEach(button=>button.onclick=()=>{const text=$('testSentenceList').querySelector(`[data-test-example-text="${button.dataset.testExampleReveal}"]`);text.hidden=!text.hidden;button.textContent=text.hidden?'Show sentence':'Hide sentence'});$('testSentenceList').querySelectorAll('[data-test-example-form]').forEach(form=>form.onsubmit=event=>{event.preventDefault();const index=+form.dataset.testExampleForm,expected=word.senses[index].example,correct=normalizeSentence(form.querySelector('input').value)===normalizeSentence(expected),feedback=form.querySelector('small');feedback.textContent=correct?'Correct sentence.':'Incorrect — the sentence is shown above.';feedback.className=correct?'correct':'wrong';if(!correct){const text=$('testSentenceList').querySelector(`[data-test-example-text="${index}"]`),button=$('testSentenceList').querySelector(`[data-test-example-reveal="${index}"]`);text.hidden=false;button.textContent='Hide sentence'}});
}
function submitTest(event){
  event.preventDefault();const word=state.words[state.testIndex],expectedWord=cleanHeadword(word),answer=$('testAnswer').value.trim().toLowerCase(),correct=answer===expectedWord.toLowerCase();if(!answer)return;
  const rec=recordFor(word.id);rec.last=Date.now();rec.repetitions=(rec.repetitions||0)+1;
  if(correct){rec.status='mastered';rec.inWordbook=false;rec.stars=0;rec.due=Date.now()+DAY*30;$('testFeedback').className='test-feedback correct';$('testFeedback').textContent=`Correct — ${expectedWord}. You can continue with sentence dictation.`;$('testContinue').hidden=false;$('testAnswer').disabled=true;saveProgress();renderStarRating('testStars',word)}
  else{rec.status='learning';rec.inWordbook=true;rec.stars=Math.max(2,rec.stars||0);rec.due=Date.now()+10*60000;$('testFeedback').className='test-feedback wrong word-only-answer';$('testFeedback').innerHTML=`Correct word: <strong>${escapeHtml(expectedWord)}</strong>`;$('testContinue').hidden=false;$('testAnswer').disabled=true;saveProgress();renderStarRating('testStars',word)}
}
function answerReview(word,message){return `<strong class="answer-word">${escapeHtml(cleanHeadword(word))}</strong><span class="answer-message">${escapeHtml(message)}</span>${word.senses.map(s=>`<span class="answer-sense"><b>${escapeHtml(s.label||word.pos)}</b>${escapeHtml(s.definition)}${s.example?`<i>“${escapeHtml(s.example)}”</i>`:''}</span>`).join('')}`}
function revealTestWord(){
  const word=state.words[state.testIndex],rec=recordFor(word.id);rec.last=Date.now();rec.repetitions=(rec.repetitions||0)+1;rec.status='learning';rec.inWordbook=true;rec.stars=Math.max(3,rec.stars||0);rec.due=Date.now()+10*60000;saveProgress();renderStarRating('testStars',word);$('testFeedback').className='test-feedback wrong answer-review';$('testFeedback').innerHTML=answerReview(word,'Added to Wordbook.');$('testAnswer').value=cleanHeadword(word);$('testAnswer').disabled=true;$('testContinue').hidden=false;setTimeout(()=>$('testFeedback').scrollIntoView({behavior:'smooth',block:'center'}),60);
}
function populateTestChapters(){
  const groups={};state.words.forEach(w=>{const key=chapterKey(w);groups[key]=(groups[key]||0)+1});$('testChapter').innerHTML=Object.entries(groups).sort((a,b)=>a[0].localeCompare(b[0])).map(([key,count])=>{const [level,category]=key.split('|||');return `<option value="${escapeHtml(key)}">${level} · ${escapeHtml(category)} (${count})</option>`}).join('');state.testChapter=$('testChapter').value;
}
function removeWritingToolOverlays(root=document){
  const suspicious=/grammarly|languagetool|language-tool|quillbot|monica|ms[-_]?editor|microsoft[-_]?editor|writing[-_]?assistant|spell[-_]?check/i;
  const nodes=root===document?[...document.body.querySelectorAll('*')]:[root,...(root.querySelectorAll?.('*')||[])];
  nodes.forEach(node=>{
    if(!(node instanceof Element)||!node.isConnected)return;
    const identity=`${node.tagName} ${node.id} ${node.className||''}`;
    const insideApp=!!node.closest('.app-shell'),allowed=node.matches('#lookupPopover,#toast,.toast,.lookup-popover')||!!node.closest('#lookupPopover');
    if(allowed)return;
    if(node.tagName==='IFRAME'||node.tagName==='CANVAS'||node.tagName.includes('-')){node.remove();return}
    if(suspicious.test(identity)){
      if(insideApp&&node.childNodes.length)node.replaceWith(...node.childNodes);else node.remove();
      return;
    }
    const readingText=!!node.closest('.sense,.practice-panel,.test-sentence-row,.test-feedback,.sidebar-footer,.subtitle,.chapter-section,.mini-card');
    if(readingText&&node.matches('u,ins,mark')){node.replaceWith(...node.childNodes);return}
    const decoration=[node.style.textDecoration,node.style.textDecorationLine].some(value=>value&&value!=='none'),border=node.style.borderBottom&&node.style.borderBottom!=='0px'&&node.style.borderBottom!=='0',shadow=node.style.boxShadow&&node.style.boxShadow!=='none',highlight=(node.style.background||node.style.backgroundColor)&&node.style.background!=='transparent'&&node.style.backgroundColor!=='transparent';
    if(readingText&&(decoration||border||shadow||highlight)){
      node.style.setProperty('text-decoration','none','important');node.style.setProperty('text-decoration-line','none','important');node.style.setProperty('border-bottom','0','important');node.style.setProperty('box-shadow','none','important');
      if(node.matches('span,u,ins,mark'))node.style.setProperty('background','transparent','important');
    }
    if(!insideApp&&getComputedStyle(node).position==='fixed')node.remove();
  });
}
function blockWritingToolOverlays(){
  removeWritingToolOverlays();
  new MutationObserver(changes=>changes.forEach(change=>{change.addedNodes.forEach(node=>{if(node.nodeType===1)removeWritingToolOverlays(node)});if(change.type==='attributes')removeWritingToolOverlays(change.target)})).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class']});
}
function setView(view){
  stopAudio();state.view=view;document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));document.querySelector('.learn-nav-group')?.classList.toggle('section-active',view==='learn'||view==='chapters');$('learnView').classList.toggle('active',view==='learn');$('testView').classList.toggle('active',view==='test');$('chaptersView').classList.toggle('active',view==='chapters');$('listView').classList.toggle('active',!['learn','test','chapters'].includes(view));document.querySelector('.sidebar').classList.remove('open');
  if(view==='test'){if(!state.testQueue.length)buildTestSession()}else if(view==='chapters')renderChapters();else if(view!=='learn')renderList();
}
function renderChapters(){
  const groups={};state.words.forEach(w=>{const key=chapterKey(w);if(!groups[key])groups[key]={level:w.level,category:w.category,words:[]};groups[key].words.push(w)});
  const levels=['A1','A2','B1','B2'];if(!levels.includes(state.chapterLevel))state.chapterLevel='A1';$('chapterLevelTabs').innerHTML=levels.map(level=>{const chapters=Object.values(groups).filter(g=>g.level===level),total=chapters.reduce((sum,g)=>sum+g.words.length,0);return `<button type="button" class="${level===state.chapterLevel?'active':''}" data-chapter-level="${level}"><strong>${level}</strong><span>${total} words · ${chapters.length} chapters</span></button>`}).join('');$('chapterLevelTabs').querySelectorAll('[data-chapter-level]').forEach(button=>button.onclick=()=>{state.chapterLevel=button.dataset.chapterLevel;renderChapters()});
  const chapters=Object.entries(groups).filter(([,g])=>g.level===state.chapterLevel).sort((a,b)=>a[1].category.localeCompare(b[1].category));$('chapterGroups').innerHTML=`<section class="chapter-section"><div class="chapter-grid">${chapters.map(([key,g])=>{const mastered=g.words.filter(w=>state.progress[w.id]?.status==='mastered').length,pct=Math.round(mastered/g.words.length*100);return `<button class="chapter-card" data-chapter="${escapeHtml(key)}"><div class="chapter-card-top"><span>${g.words.length} words</span><span>${pct}% mastered</span></div><h3>${escapeHtml(g.category)}</h3><div class="chapter-progress"><span style="width:${pct}%"></span></div><small>${mastered} of ${g.words.length} complete</small></button>`}).join('')}</div></section>`;
  $('chapterGroups').querySelectorAll('.chapter-card').forEach(card=>card.onclick=()=>{state.activeChapter=card.dataset.chapter;const indexes=studyIndices(),unseen=indexes.find(i=>state.progress[state.words[i].id]?.status!=='mastered');state.current=unseen??indexes[0];setView('learn');renderWord();toast(`Chapter: ${currentWord().category}`)});
}
function listWords(){
  const now=Date.now();let words=state.words;
  if(state.view==='review')words=words.filter(w=>{const r=state.progress[w.id];return r&&r.status!=='mastered'&&r.due&&r.due<=now});
  if(state.view==='wordbook')words=words.filter(w=>{const r=state.progress[w.id];return r&&r.status!=='mastered'&&(r.inWordbook===true||r.stars>0)});
  if(state.view==='mastered')words=words.filter(w=>state.progress[w.id]?.status==='mastered');
  if(state.level!=='all')words=words.filter(w=>w.level===state.level);
  if(state.query){const q=state.query.toLowerCase();words=words.filter(w=>w.word.toLowerCase().includes(q)||(w.grammar||w.pos).toLowerCase().includes(q)||w.category.toLowerCase().includes(q)||w.senses.some(s=>s.definition.toLowerCase().includes(q)||(s.example||'').toLowerCase().includes(q)));words.sort((a,b)=>{const aw=a.word.toLowerCase(),bw=b.word.toLowerCase();return Number(bw===q)-Number(aw===q)||Number(bw.startsWith(q))-Number(aw.startsWith(q))||aw.localeCompare(bw)})}
  return words;
}
function renderList(){
  const labels={search:[`ALL ${state.words.length.toLocaleString('en-US')} WORDS`,state.query?`Results for “${state.query}”`:'Search','Search by word, part of speech, meaning, example, or topic.'],review:['DUE NOW','Review','Words ready for spaced repetition.'],wordbook:['YOUR COLLECTION','Wordbook','Your starred words, ordered by priority.'],mastered:['LONG-TERM MEMORY','Mastered','Words you already know and can revisit anytime.']};const [eye,title,sub]=labels[state.view]||labels.wordbook;$('listEyebrow').textContent=eye;$('listTitle').textContent=title;$('listSubtitle').textContent=sub;
  let words=listWords();if(state.view==='wordbook')words.sort((a,b)=>(state.progress[b.id]?.stars||0)-(state.progress[a.id]?.stars||0));
  $('wordGrid').innerHTML=words.slice(0,240).map(w=>`<article class="mini-card" data-id="${w.id}"><div class="mini-card-top"><span class="pill">${w.level}</span><span>${'★'.repeat(state.progress[w.id]?.stars||0)}</span></div><h3>${escapeHtml(cleanHeadword(w))}</h3><p>${escapeHtml(w.senses[0]?.definition||'')}</p></article>`).join('');
  $('emptyState').style.display=words.length?'none':'block';if(!words.length){$('emptyState').querySelector('h2').textContent=state.view==='search'?'No matching words.':'No words here yet.';$('emptyState').querySelector('p').textContent=state.view==='search'?'Try another word, meaning, example, or topic.':'Star a word or complete a review to build your collection.'}$('wordGrid').querySelectorAll('.mini-card').forEach(c=>c.onclick=()=>{state.current=state.words.findIndex(w=>w.id===+c.dataset.id);state.activeChapter=null;setView('learn');renderWord()});
}
function updateStats(){
  const records=Object.entries(state.progress).filter(([id])=>!id.startsWith('__')).map(([,record])=>record),explored=records.filter(r=>r.last).length,mastered=records.filter(r=>r.status==='mastered').length,wordbook=records.filter(r=>r.status!=='mastered'&&(r.inWordbook===true||r.stars>0)).length,due=records.filter(r=>r.status!=='mastered'&&r.due&&r.due<=Date.now()).length;
  $('overallCount').textContent=explored;$('overallBar').style.width=`${Math.min(100,explored/Math.max(1,state.words.length)*100)}%`;$('reviewBadge').textContent=due;
  $('wordbookBadge').textContent=wordbook;$('masteredBadge').textContent=`${mastered} / ${state.words.length}`;
  const today=new Date().toDateString(),todayCount=records.filter(r=>r.last&&new Date(r.last).toDateString()===today).length;$('dailyCount').textContent=todayCount;document.querySelector('.daily-ring').style.setProperty('--daily',`${Math.min(100,todayCount/20*100)}%`);
  const dates=[...new Set(records.filter(r=>r.last).map(r=>new Date(r.last).toDateString()))];let streak=0,d=new Date();while(dates.includes(d.toDateString())){streak++;d.setDate(d.getDate()-1)}$('streakCount').textContent=streak;
}
async function init(){
  blockWritingToolOverlays();
  state.progress=await loadProgress();state.words=await fetch('public/vocabulary.json?v=20260717-words3000').then(r=>r.json());const savedWordId=state.progress.__settings?.lastWordId,savedIndex=state.words.findIndex(word=>String(word.id)===String(savedWordId));if(savedIndex>=0)state.current=savedIndex;$('searchInput').placeholder=`Search ${state.words.length.toLocaleString()} words`;populateTestChapters();renderWord();updateStats();syncProgressNow();
  document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>{state.query='';$('searchInput').value='';setView(b.dataset.view);if(b.dataset.view==='learn')renderWord()});document.querySelectorAll('[data-rating]').forEach(b=>b.onclick=()=>rate(b.dataset.rating));
  $('nextButton').onclick=nextWord;$('previousButton').onclick=previousWord;$('wordbookButton').onclick=addCurrentToWordbook;$('masteredButton').onclick=markCurrentMastered;$('randomButton').onclick=()=>{const indexes=studyIndices();state.current=indexes[Math.floor(Math.random()*indexes.length)];renderWord()};
  $('toggleExamples').onclick=()=>{state.showExampleText=!state.showExampleText;renderWord(false)};
  document.querySelector('[data-speak="word"]').onclick=()=>speakWord(currentWord());$('searchInput').oninput=e=>{state.query=e.target.value.trim();if(state.query){setView('search');renderList()}else if(state.view==='search'){setView('learn')}};$('searchInput').onkeydown=e=>{if(e.key==='Enter'&&state.query){const first=listWords()[0];if(first){e.preventDefault();state.current=state.words.findIndex(w=>w.id===first.id);state.activeChapter=null;state.query='';$('searchInput').value='';setView('learn');renderWord()}}};$('levelFilter').onchange=e=>{state.level=e.target.value;renderList()};$('menuButton').onclick=()=>document.querySelector('.sidebar').classList.toggle('open');
  $('resetButton').onclick=()=>{if(confirm('Reset all stars, reviews, and mastered words?')){state.progress={};saveProgress();renderWord();toast('Learning data reset')}};
  $('allWordsButton').onclick=()=>{state.activeChapter=null;state.current=0;setView('learn');renderWord();toast('Studying all words')};
  $('chaptersShortcut').onclick=()=>setView('chapters');
  $('testForm').onsubmit=submitTest;$('testReplay').onclick=()=>playTestAudio(state.words[state.testIndex]);$('testHintToggle').onchange=renderTestHint;document.querySelectorAll('[data-audio-rate]').forEach(button=>button.onclick=()=>{state.audioRate=+button.dataset.audioRate;document.querySelectorAll('[data-audio-rate]').forEach(item=>item.classList.toggle('active',item===button));if(activeAudio)activeAudio.playbackRate=state.audioRate;toast(`Playback speed: ${state.audioRate}×`)});$('testUnknown').onclick=revealTestWord;$('testContinue').onclick=nextTestWord;$('testPrevious').onclick=previousTestWord;$('testRestart').onclick=buildTestSession;$('testMode').onchange=e=>{state.testMode=e.target.value;$('testChapter').hidden=state.testMode!=='chapter';buildTestSession()};$('testChapter').onchange=e=>{state.testChapter=e.target.value;buildTestSession()};
  document.addEventListener('mouseup',()=>setTimeout(handleTextSelection,10));
  document.addEventListener('touchend',()=>setTimeout(handleTextSelection,80));
  $('lookupClose').onclick=()=>$('lookupPopover').classList.remove('open');
  document.addEventListener('mousedown',event=>{if(!event.target.closest('#lookupPopover')&&!event.target.closest('.sense'))$('lookupPopover').classList.remove('open')});
  document.addEventListener('keydown',event=>{
    if($('lookupPopover').classList.contains('open'))return;
    if(state.view==='test'&&event.key==='ArrowLeft'){event.preventDefault();previousTestWord();return}
    if(state.view==='test'&&event.key==='ArrowRight'){event.preventDefault();nextTestWord();return}
    if(event.target.matches('input, select, textarea'))return;
    if(state.view!=='learn')return;
    if(event.key==='ArrowRight'){event.preventDefault();nextWord()}
    if(event.key==='ArrowLeft'){event.preventDefault();previousWord()}
    if(event.key==='Enter'&&event.ctrlKey){
      if(event.repeat)return;
      event.preventDefault();
      addCurrentToWordbook();
    }else if(event.key==='Enter'){
      if(event.repeat)return;
      event.preventDefault();markCurrentMastered();
    }
  });
  window.addEventListener('beforeunload',()=>{const blob=new Blob([JSON.stringify(state.progress)],{type:'application/json'});navigator.sendBeacon('/api/progress',blob)});
}
init().catch(()=>{document.body.innerHTML='<main style="padding:60px;font-family:sans-serif"><h1>koko.okok could not load.</h1><p>Start the included local server, then open the address it provides.</p></main>'});
