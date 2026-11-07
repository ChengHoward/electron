// Run against a desktop preview build. Uses only disposable pages and windows.
const {app, BaseWindow, WebContentsView, screen} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const out = process.env.SCROLLBAR_CORNERS_OUTPUT;
if (!out || !path.isAbsolute(out)) throw Error('Set absolute SCROLLBAR_CORNERS_OUTPUT');
fs.mkdirSync(out, {recursive:true});
app.setPath('userData', path.join(out, 'profile'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let win, view;
const read = code => view.webContents.executeJavaScript(code);
async function test(name, check) {
  try { await check(); results.push({name,ok:true}); }
  catch(error) { results.push({name,ok:false,error:error.message}); }
}
async function click(x,y) {
  view.webContents.sendInputEvent({type:'mouseMove',x,y});
  view.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
  await delay(45);
  view.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});
  await delay(350);
}
async function load({horizontal=true,vertical=true,custom=false,nested=false,rtl=false}={}) {
  const html=`<!doctype html><style>
    html{background:#00aa44;overflow-y:${vertical?'scroll':'hidden'};overflow-x:${horizontal?'scroll':'hidden'};direction:${rtl?'rtl':'ltr'}}
    body{margin:0;width:${horizontal?1800:400}px;height:${vertical?1800:200}px}
    ${custom?'::-webkit-scrollbar{width:24px;height:24px}::-webkit-scrollbar-track{background:#ffff00}::-webkit-scrollbar-thumb{background:#0000ff}':''}
    #nested{width:220px;height:180px;overflow:scroll;background:white}#inside{width:600px;height:700px}
    </style>${nested?'<div id="nested"><div id="inside"></div></div>':''}`;
  await view.webContents.loadURL('data:text/html,'+encodeURIComponent(html));
  await delay(350);
}
async function reset(x=200,y=200) { await read(`scrollTo({left:${x},top:${y},behavior:'instant'})`); await delay(350); }
async function changedAt(name,x,y,axis,direction,arrow=true) {
  await test(name,async()=>{
    await reset();const before=await read(axis==='x'?'scrollX':'scrollY');
    await click(x,y);const after=await read(axis==='x'?'scrollX':'scrollY');
    assert(direction<0?after<before:after>before,`scroll ${axis}: ${before} -> ${after}`);
    if (arrow) assert(Math.abs(after-before)<=60,`expected one arrow step, got ${before} -> ${after}`);
  });
}
async function capture(name) {
  await delay(250);
  const bounds=screen.dipToScreenRect(win,win.getBounds());
  const image=path.join(out,name+'.png');
  const script="import sys,json;from PIL import ImageGrab;b=json.loads(sys.argv[1]);ImageGrab.grab(bbox=(b['x'],b['y'],b['x']+b['width'],b['y']+b['height']),all_screens=True).save(sys.argv[2])";
  const result=spawnSync(process.env.SCROLLBAR_CORNERS_PYTHON||'python',
    ['-c',script,JSON.stringify(bounds),image],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw Error(result.stderr);
}

function finish() {
  const report={executableSha256:crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    electron:process.versions.electron,displayScale:screen.getDisplayMatching(win.getBounds()).scaleFactor,
    summary:{total:results.length,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length},results};
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  view.webContents.close();win.destroy();app.exit(report.summary.failed?1:0);
}

app.whenReady().then(async()=>{
  win=new BaseWindow({width:680,height:560,frame:false,backgroundColor:'#ff00ff',alwaysOnTop:true});
  view=new WebContentsView();win.contentView.addChildView(view);
  view.setBounds({x:40,y:40,width:600,height:480});view.setBorderRadius(48);
  win.show();win.focus();
  if (app.commandLine.hasSwitch('disable-desktop-scrollbar-corner-avoidance')) {
    await load();
    await changedAt('disabled feature retains original top arrow',595,9,'y',-1);
    await test('disabled feature does not inset the track',async()=>{
      await reset();const before=await read('scrollY');await click(595,57);
      assert(before-await read('scrollY')>60);
    });
    await capture('avoidance-disabled');finish();return;
  }
  async function compactChecks() {
    view.setBorderRadius(12); await load({horizontal:false});
    await changedAt('12 DIP radius keeps top arrow close to edge',595,9,'y',-1);
    await changedAt('12 DIP radius keeps bottom arrow close to edge',595,471,'y',1);
    await load({vertical:false});
    await changedAt('12 DIP radius keeps left arrow close to edge',9,475,'x',-1);
    await changedAt('12 DIP radius keeps right arrow close to edge',591,475,'x',1);
    view.setBorderRadius(8); await load({horizontal:false});
    await changedAt('8 DIP radius retains compact top arrow',595,9,'y',-1);
    view.setBorderRadius(16); await delay(200);
    await changedAt('16 DIP radius protects arrow without full radius gap',595,11,'y',-1);
  }
  if (process.env.SCROLLBAR_CORNERS_COMPACT_ONLY === '1') {
    await compactChecks(); finish(); return;
  }
  await load();await capture('radius48-top');
  await test('initial native scrollbar width retained',async()=>{
    const gap=await read('innerWidth-document.documentElement.clientWidth');assert(gap>0&&gap<20,`width ${gap}`);
  });
  await changedAt('vertical back arrow moved below upper corner',595,44,'y',-1);
  await changedAt('vertical forward arrow moved above lower corner',595,436,'y',1);
  await changedAt('horizontal back arrow moved past left corner',44,475,'x',-1);
  await changedAt('horizontal forward arrow moved before right corner',556,475,'x',1);
  await test('old top arrow area is no longer interactive',async()=>{
    await reset();const before=await read('scrollY');await click(595,9);assert.equal(await read('scrollY'),before);
  });
  await test('thumb drag uses shortened track',async()=>{
    await reset(200,0);view.webContents.sendInputEvent({type:'mouseMove',x:595,y:85});
    view.webContents.sendInputEvent({type:'mouseDown',x:595,y:85,button:'left',clickCount:1});
    view.webContents.sendInputEvent({type:'mouseMove',x:595,y:240,button:'left'});
    view.webContents.sendInputEvent({type:'mouseUp',x:595,y:240,button:'left',clickCount:1});
    await delay(350);assert(await read('scrollY')>200);
  });
  await read('scrollTo(1800,1800)');await capture('radius48-bottom');
  view.setBorderRadius(24);await delay(200);
  await changedAt('radius updates relayout native arrow',595,24,'y',-1);
  view.setBorderRadius(0);await delay(200);
  await changedAt('zero radius restores original arrow',595,9,'y',-1);
  view.setBorderRadius(48);await load({vertical:false});
  await changedAt('horizontal-only forward arrow avoids right corner',556,475,'x',1);
  await load({horizontal:false});
  await changedAt('vertical-only forward arrow avoids bottom corner',595,436,'y',1);
  view.webContents.setZoomFactor(1.25);await delay(200);await capture('zoom125');
  await changedAt('page zoom preserves physical arrow clearance',595,44,'y',-1);
  view.webContents.setZoomFactor(1);await load({custom:true});
  await changedAt('author custom scrollbar retains original top track',588,25,'y',-1,false);
  await capture('author-scrollbar-unchanged');
  await load({nested:true});
  await test('nested overflow scrollbar remains at its own top',async()=>{
    await read('document.querySelector("#nested").scrollTop=200');await click(212,9);
    assert(await read('document.querySelector("#nested").scrollTop')<200);
  });
  await load();view.setBounds({x:40,y:40,width:520,height:400});await delay(200);
  await changedAt('resize updates arrow geometry',515,44,'y',-1);
  view.setBounds({x:40,y:40,width:600,height:480});
  await test('cross-window transfer retains avoidance',async()=>{
    const other=new BaseWindow({width:680,height:560,frame:false,backgroundColor:'#ff00ff',alwaysOnTop:true});
    other.contentView.addChildView(view);other.show();other.focus();await delay(250);
    await reset();const before=await read('scrollY');await click(595,44);
    assert(await read('scrollY')<before);win.contentView.addChildView(view);win.focus();other.destroy();
  });
  await test('iframe scrollbar retains its original arrow position',async()=>{
    await read(`new Promise(resolve=>{
      const frame=document.createElement('iframe');frame.id='child';
      frame.style='position:fixed;left:100px;top:80px;width:240px;height:200px;border:0';
      frame.onload=()=>{frame.contentWindow.scrollTo(0,200);resolve()};
      frame.srcdoc='<body style="margin:0;height:900px;background:white">';
      document.body.appendChild(frame);
    })`);
    await delay(200);await click(333,89);
    const after=await read('document.querySelector("#child").contentWindow.scrollY');
    assert(after<200&&after>=140,`iframe arrow scroll: ${after}`);
  });
  await compactChecks();
  await load();view.setBorderRadius(999999);view.setBounds({x:40,y:40,width:40,height:40});await delay(200);
  await test('tiny view with excessive radius remains responsive',async()=>assert.equal(await read('1+1'),2));
  finish();
}).catch(error=>{console.error(error);app.exit(1)});
