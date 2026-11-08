import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTouchHoldSpeed } from './touchHoldSpeed.mjs';

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ownerDocument = new EventTarget();
  ownerDocument.defaultView = new EventTarget();
  ownerDocument.hidden = false;
  const video = new EventTarget();
  Object.assign(video, { ownerDocument, paused: false, ended: false, playbackRate: 1.5 });
  const changes = [];
  const cleanup = bindTouchHoldSpeed(video, (...args) => { video.playbackRate = args[0]; changes.push(args); }, () => 1.5);
  t.after(cleanup);
  const send = (type, props = {}, target = video) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 20, clientY: 20 }, props);
    target.dispatchEvent(event);
    return event;
  };
  return { video, ownerDocument, changes, cleanup, send };
}

test('画面按住300ms临时2倍速，松开恢复偏好且不改变暂停状态', t => {
  const { video, ownerDocument, changes, send } = setup(t);
  send('pointerdown');
  t.mock.timers.tick(299); assert.equal(video.playbackRate, 1.5);
  t.mock.timers.tick(1); assert.equal(video.playbackRate, 2);
  assert.deepEqual(changes[0], [2, true, false], '临时速度不能写入偏好');
  send('pointerup', {}, ownerDocument.defaultView);
  assert.equal(video.playbackRate, 1.5);
  assert.equal(video.paused, false);
});

test('短按、滚动和暂停画面不启动临时倍速', t => {
  const { video, ownerDocument, changes, send } = setup(t);
  send('pointerdown'); send('pointerup', {}, ownerDocument.defaultView);
  t.mock.timers.tick(400); assert.equal(changes.length, 0);
  send('pointerdown'); send('pointermove', { clientY: 40 }, ownerDocument.defaultView);
  t.mock.timers.tick(400); assert.equal(changes.length, 0);
  video.paused = true; send('pointerdown');
  t.mock.timers.tick(400); assert.equal(changes.length, 0);
});

test('取消、失焦及卸载恢复速度，旧计时器不会再次启动', t => {
  const { video, ownerDocument, cleanup, send } = setup(t);
  send('pointerdown'); t.mock.timers.tick(300);
  send('pointercancel', {}, ownerDocument.defaultView); assert.equal(video.playbackRate, 1.5);
  send('pointerdown'); t.mock.timers.tick(300);
  ownerDocument.defaultView.dispatchEvent(new Event('blur')); assert.equal(video.playbackRate, 1.5);
  send('pointerdown'); cleanup(); t.mock.timers.tick(500);
  assert.equal(video.playbackRate, 1.5);
});
