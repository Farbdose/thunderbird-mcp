"use strict";
// Offline sync helpers: on-demand download of single messages and whole folders.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHelpers(deps) {
  const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
  const start = source.indexOf("// BEGIN OFFLINE SYNC HELPERS");
  const end = source.indexOf("// END OFFLINE SYNC HELPERS", start);
  assert.ok(start >= 0 && end > start, "offline sync markers missing");
  // nsITimer stand-in backed by Node timers; cancel() must stop a pending callback.
  const timers = { created: 0, cancelled: 0 };
  const sandbox = {
    console, Date, Promise, Number, Boolean,
    getAccessibleFolder: deps.getAccessibleFolder,
    ChromeUtils: { generateQI: (names) => names },
    Ci: { nsITimer: { TYPE_ONE_SHOT: 0 } },
    Cc: { "@mozilla.org/timer;1": { createInstance: () => {
      timers.created += 1;
      return {
        initWithCallback(callback, delayMs) { this.handle = setTimeout(() => callback.notify(this), delayMs); },
        cancel() { timers.cancelled += 1; clearTimeout(this.handle); },
      };
    } } },
    timers,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)}
this.ensureOfflineCopy = ensureOfflineCopy; this.hasOfflineCopy = hasOfflineCopy; this.syncFolder = syncFolder;`, sandbox);
  return sandbox;
}

function makeFolder({ type = "imap", flags = 0, headers = [] } = {}) {
  const folder = {
    URI: "imap://user@host/Trash", flags, server: { type }, messages: headers,
    setFlagCalls: [], downloadCalls: [], downloadAllCalls: 0,
    hasMsgOffline(key) { return headers.some(h => h.messageKey === key && (h.flags & 0x80)); },
    setFlag(f) { this.setFlagCalls.push(f); this.flags |= f; },
    downloadMessagesForOffline(hdrs) { this.downloadCalls.push(Array.from(hdrs, h => h.messageKey)); setTimeout(() => hdrs.forEach(h => { h.flags |= 0x80; }), 5); },
    downloadAllForOffline(listener) { this.downloadAllCalls += 1; setTimeout(() => { headers.forEach(h => { h.flags |= 0x80; }); listener.OnStopRunningUrl(null, 0); }, 5); },
  };
  headers.forEach(h => { h.folder = folder; });
  return folder;
}

describe("ensureOfflineCopy", () => {
  it("downloads a missing IMAP copy and waits for it", async () => {
    const hdr = { messageKey: 1, flags: 0 };
    const folder = makeFolder({ headers: [hdr] });
    const h = loadHelpers({});
    assert.equal(h.hasOfflineCopy(hdr), false);
    assert.equal(await h.ensureOfflineCopy(hdr, 1000), true);
    assert.deepEqual(folder.downloadCalls, [[1]]);
    assert.equal(h.hasOfflineCopy(hdr), true);
  });
  it("does nothing for local folders or existing copies", async () => {
    const h = loadHelpers({});
    const local = { messageKey: 2, flags: 0 }; makeFolder({ type: "none", headers: [local] });
    assert.equal(await h.ensureOfflineCopy(local), true);
    assert.deepEqual(local.folder.downloadCalls, []);
    const cached = { messageKey: 3, flags: 0x80 }; makeFolder({ headers: [cached] });
    assert.equal(await h.ensureOfflineCopy(cached), true);
    assert.deepEqual(cached.folder.downloadCalls, []);
  });
  it("resolves false when the download never lands", async () => {
    const hdr = { messageKey: 4, flags: 0 };
    const folder = makeFolder({ headers: [hdr] });
    folder.downloadMessagesForOffline = () => {};
    const h = loadHelpers({});
    assert.equal(await h.ensureOfflineCopy(hdr, 50), false);
  });
});

describe("syncFolder", () => {
  it("sets the offline flag, downloads everything and reports counts", async () => {
    const headers = [{ messageKey: 1, flags: 0 }, { messageKey: 2, flags: 0x80 }];
    const folder = makeFolder({ headers });
    const h = loadHelpers({ getAccessibleFolder: () => ({ folder }) });
    const res = await h.syncFolder(folder.URI, 1000);
    assert.equal(res.success, true);
    assert.equal(res.offlineFlagSet, true);
    assert.deepEqual([res.messages, res.offlineBefore, res.offlineAfter, res.completed], [2, 1, 2, true]);
    assert.equal(folder.downloadAllCalls, 1);
    assert.equal(h.timers.cancelled, 1, "the timeout timer is cancelled once the download finished");
  });
  it("leaves an existing offline flag alone and keeps the listener typed", async () => {
    const folder = makeFolder({ flags: 0x08000000, headers: [{ messageKey: 1, flags: 0 }] });
    let listener;
    const download = folder.downloadAllForOffline;
    folder.downloadAllForOffline = function (l) { listener = l; return download.call(this, l); };
    const h = loadHelpers({ getAccessibleFolder: () => ({ folder }) });
    const res = await h.syncFolder(folder.URI, 1000);
    assert.equal(res.offlineFlagSet, false);
    assert.deepEqual(folder.setFlagCalls, []);
    assert.equal(res.completed, true);
    assert.deepEqual(Array.from(listener.QueryInterface), ["nsIUrlListener"]);
  });
  it("reports a failed download start as an error", async () => {
    const folder = makeFolder({ headers: [{ messageKey: 1, flags: 0 }] });
    folder.downloadAllForOffline = () => { throw new Error("folder busy"); };
    const h = loadHelpers({ getAccessibleFolder: () => ({ folder }) });
    const res = await h.syncFolder(folder.URI, 1000);
    assert.equal(res.success, false);
    assert.match(res.error, /folder busy/);
    assert.equal(res.completed, false);
  });
  it("skips non-IMAP folders and validates input", async () => {
    const folder = makeFolder({ type: "none", headers: [{ messageKey: 1, flags: 0x80 }] });
    const h = loadHelpers({ getAccessibleFolder: (p) => (p === folder.URI ? { folder } : { error: "Folder not found" }) });
    const res = await h.syncFolder(folder.URI);
    assert.equal(res.success, true);
    assert.match(res.note, /not an IMAP folder/);
    assert.equal(folder.downloadAllCalls, 0);
    assert.equal((await h.syncFolder("")).error, "folderPath must be a non-empty string");
    assert.equal((await h.syncFolder("x")).error, "Folder not found");
  });
  it("reports a timeout when the download does not finish", async () => {
    const folder = makeFolder({ headers: [{ messageKey: 1, flags: 0 }] });
    folder.downloadAllForOffline = () => {};
    const h = loadHelpers({ getAccessibleFolder: () => ({ folder }) });
    const res = await h.syncFolder(folder.URI, 30);
    assert.equal(res.completed, false);
    assert.match(res.note, /still running/);
    assert.equal(res.success, true);
    assert.equal(res.offlineAfter, 0);
  });
});
