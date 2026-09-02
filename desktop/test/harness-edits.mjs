import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { Harness, escapesRoot } from '../dist-main/main/harness.js';
import { pathInside, samePath } from '../dist-main/main/platform.js';
import { FolderStore } from '../dist-main/main/folders.js';

const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'noteHarnessChange');
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emma-edit-capture-')));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'emma-edit-outside-'));
try {
  const captured = [], reads = [], snapshots = new Map();
  const folders = new FolderStore(path.join(cwd, 'profile'));
  const [grant] = folders.add(cwd);
  const note = vm.runInNewContext(ts.transpileModule('(' + node.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    escapesRoot, folders, path, pathInside, samePath,
    readFileSync: (...args) => { reads.push(args[0]); return fs.readFileSync(...args); },
    harnessBefore: snapshots, agents: { noteChange: (threadId, change) => captured.push({ threadId, ...change }) }, changed() {},
  });
  const calls = [];
  const h = new Harness({ onToolCall: call => { calls.push(call); note(cwd, call); } });
  const relative = 'nested/'.repeat(50) + 'file.txt';
  const file = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'before');
  const input = JSON.stringify({ content: 'x'.repeat(6000), path: relative }).slice(0, 4096);
  assert.throws(() => JSON.parse(input));
  h.applyUpdate('t', { sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', status: 'pending', rawInput: input, _emma_filePath: relative });
  fs.writeFileSync(file, 'after');
  h.applyUpdate('t', { sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].before, 'before');
  assert.equal(captured[0].after, 'after');
  assert.equal(captured[0].path, relative);
  assert.equal(calls[1].filePath, relative);
  assert.equal(snapshots.size, 0);
  const capability = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'boundedCapabilityId');
  let revertNode;
  function findRevert(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle' && node.arguments[0]?.text === 'emma:revert-change') revertNode = node.arguments[1];
    ts.forEachChild(node, findRevert);
  }
  findRevert(source);
  assert.ok(revertNode);
  // The handler writes the body recordedRevert looks up, never the one the request carries, so the
  // recorded changes have to be in the vm alongside it for the revert to have anything to restore.
  const lookup = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'recordedRevert');
  const revert = vm.runInNewContext(ts.transpileModule(capability.getText(source) + '\n' + lookup.getText(source) + '\n(' + revertNode.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    Buffer, escapesRoot, folders, changed() {}, mainWindowSender(event) { assert.equal(event.trusted, true); },
    agents: { list: () => [{ threadId: 't' }], changes: () => captured },
  });
  // The body in the request is a decoy: what lands on disk is the one the harness recorded.
  assert.equal(revert({ trusted: true }, { ...captured[0], before: 'whatever the caller typed' }), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  const outsideFile = path.join(outside, 'file.txt');
  fs.writeFileSync(outsideFile, 'outside');
  fs.symlinkSync(outside, path.join(cwd, 'escape'));
  fs.symlinkSync(outsideFile, path.join(cwd, 'escaped-file.txt'));
  for (const bad of [undefined, '', 42, {}, 'bad\0file', 'x'.repeat(4097), '../outside', outsideFile, 'escape/file.txt', 'escaped-file.txt']) {
    assert.throws(() => revert({ trusted: true }, { folderId: grant.id, path: bad, before: 'invalid' }));
  }
  assert.throws(() => revert({ trusted: false }, captured[0]));
  // A path inside the grant that the harness never rewrote has no recorded body to put back.
  assert.throws(() => revert({ trusted: true }, { folderId: grant.id, path: 'nested/other.txt', before: 'planted' }));
  assert.throws(() => revert({ trusted: true }, { ...captured[0], folderId: 'missing' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside');
  const readCount = reads.length;
  for (const [index, bad] of [undefined, '', 42, {}, 'bad\0file', '../outside', outside, 'escape/file.txt'].entries()) {
    for (const status of ['pending', 'completed']) h.applyUpdate('t', { sessionUpdate: 'tool_call', toolCallId: 'bad' + index, kind: 'edit', status, _emma_filePath: bad });
  }
  h.applyUpdate('t', { sessionUpdate: 'tool_call', toolCallId: 'history', kind: 'edit', status: 'completed', _emma_filePath: relative });
  assert.equal(reads.length, readCount);
  assert.equal(captured.length, 1);
  for (const thread of ['parent', 'child']) {
    h.applyUpdate(thread, { sessionUpdate: 'tool_call', toolCallId: 'same', kind: 'edit', status: 'pending', _emma_filePath: relative });
    fs.writeFileSync(file, thread);
  }
  h.applyUpdate('parent', { sessionUpdate: 'tool_call_update', toolCallId: 'same', status: 'failed' });
  h.applyUpdate('child', { sessionUpdate: 'tool_call_update', toolCallId: 'same', status: 'completed' });
  assert.equal(captured[1].threadId, 'child');
  assert.equal(captured[1].before, 'parent');
  assert.equal(snapshots.size, 0);
  console.log('Harness edit capture and IPC revert: complete path, restored before text, rejected escapes, and child IDs passed');
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
