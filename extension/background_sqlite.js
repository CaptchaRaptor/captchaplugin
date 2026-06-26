
importScripts(chrome.runtime.getURL('lib/sql-wasm.js'));
if (typeof self.initSqlJs !== 'function') {
  console.error('initSqlJs not found in sql-wasm.js — stop!');
  throw new Error('sql.js runtime not available');
}


const SQLPromise = self.initSqlJs({
  locateFile: f => chrome.runtime.getURL('lib/' + f)        
});

const DBPromise = SQLPromise.then(async SQL => {
  
  const buf = await (await fetch(
    chrome.runtime.getURL('db/captcha.sqlite')
  )).arrayBuffer();

  return new SQL.Database(new Uint8Array(buf));              
});


function hamming64(a, b) {                   
  let v = BigInt.asUintN(64, a ^ b), c = 0n;
  while (v) { v &= v - 1n; c++; }
  return Number(c);
}


self.queryPhash = async function ({ imgtype, name: label, phash }) {
  const db = await DBPromise;

  
  const big = BigInt('0x' + phash);
  const b0 = Number((big >> 48n) & 0xFFFFn);
  const b1 = Number((big >> 32n) & 0xFFFFn);
  const b2 = Number((big >> 16n) & 0xFFFFn);
  const b3 = Number( big         & 0xFFFFn);

      console.log(`[queryPhash] trying to find: ${phash}, ${label}, ${imgtype}`);

  
  if (!self._stmt33) {
    self._stmt33 = db.prepare(`
      SELECT CAST(phash AS TEXT) AS phash, selected
      FROM   phash33
      WHERE  label = ? AND (
        (band0=? AND band1=?) OR (band0=? AND band2=?) OR (band0=? AND band3=?) OR
        (band1=? AND band2=?) OR (band1=? AND band3=?) OR (band2=? AND band3=?))
    `);
    self._stmt44 = db.prepare(`
      SELECT phash, mask
      FROM   phash44
      WHERE  label = ? AND (
        (band0=? AND band1=?) OR (band0=? AND band2=?) OR (band0=? AND band3=?) OR
        (band1=? AND band2=?) OR (band1=? AND band3=?) OR (band2=? AND band3=?))
    `);
  }

  const stmt   = imgtype === '33' ? self._stmt33 : self._stmt44;
  const params = [label, b0,b1, b0,b2, b0,b3, b1,b2, b1,b3, b2,b3];

  const candidates = [];
  stmt.bind(params);
  while (stmt.step()) candidates.push(stmt.getAsObject());
  stmt.reset();

for (const c of candidates) {
  c.hamming = hamming64(BigInt(c.phash), big);
}


console.log(`[queryPhash] found ${candidates.length} candidates :`);
for (const c of candidates) {
  console.log(`phash: ${c.phash}, selected/mask: ${c.selected ?? c.mask}, distance: ${c.hamming}`);
}


const hit = candidates.find(r => r.hamming < 10);
  if (!hit) return {};                               

  return imgtype === '33'
       ? { selected: !!hit.selected }                
       : { selected: hit.mask.toString(16).toUpperCase().padStart(4, '0') };
};



