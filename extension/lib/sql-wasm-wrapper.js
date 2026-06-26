import './sql-wasm.js';          

const fn = globalThis.initSqlJs;
if (typeof fn !== 'function') {
  throw new Error('initSqlJs not found after executing sql-wasm.js');
}
export const initSqlJs = fn;    
