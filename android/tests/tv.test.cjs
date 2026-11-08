const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load() {
  const source = fs.readFileSync(path.join(__dirname, '../web/tv-navigation.js'), 'utf8');
  const module = {exports:{}};
  vm.runInNewContext(source, {module});
  return module.exports;
}
const box = (x,y,w=100,h=60) => ({left:x,top:y,right:x+w,bottom:y+h,width:w,height:h});

test('TV方向键优先同行／同列，不绕到反方向，动态移除后仍可恢复焦点', () => {
  const {nextFocus} = load();
  const cells = [box(0,0),box(120,0),box(240,0),box(0,100),box(120,100)];
  assert.equal(nextFocus(cells,0,'ArrowRight'),1);
  assert.equal(nextFocus(cells,1,'ArrowDown'),4);
  assert.equal(nextFocus(cells,4,'ArrowUp'),1);
  assert.equal(nextFocus(cells,2,'ArrowRight'),2);
  assert.equal(nextFocus(cells,-1,'ArrowDown'),0);
  assert.equal(nextFocus([],0,'ArrowDown'),-1);
});

test('TV播放键暂停与恢复，快进不越界，确认键不在长按时重复执行', () => {
  const {handleMediaKey} = load();
  const video = {paused:true,currentTime:8,duration:12,play(){this.paused=false;return Promise.resolve();},pause(){this.paused=true;}};
  assert.equal(handleMediaKey(video,'MediaPlayPause',false),true);
  assert.equal(video.paused,false);
  handleMediaKey(video,'MediaPlayPause',true);
  assert.equal(video.paused,false);
  handleMediaKey(video,'MediaPlayPause',false);
  assert.equal(video.paused,true);
  handleMediaKey(video,'MediaFastForward',false);
  assert.equal(video.currentTime,12);
  handleMediaKey(video,'MediaRewind',false);
  assert.equal(video.currentTime,2);
  assert.equal(handleMediaKey(video,'ArrowDown',false),false);
  assert.equal(handleMediaKey(null,'MediaPlayPause',false),false);
});
