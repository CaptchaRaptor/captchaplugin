

const COS32 = (() => {
  const N = 32, k = Math.PI / (2 * N);
  const cos = Array.from({ length: N }, () => new Float64Array(N));
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      cos[i][j] = Math.cos((2 * i + 1) * j * k);
  return cos;
})();

function dct1(vec, cos, N = 32) {
  const out = new Float64Array(N), c0 = Math.sqrt(1 / N), cu = Math.sqrt(2 / N);
  for (let u = 0; u < N; u++) {
    let sum = 0;
    for (let x = 0; x < N; x++) sum += vec[x] * cos[x][u];
    out[u] = (u ? cu : c0) * sum;
  }
  return out;
}

function dct2(mat, cos, N = 32) {
  const tmp = Array.from({ length: N }, () => new Float64Array(N));
  for (let y = 0; y < N; y++) tmp[y] = dct1(mat[y], cos, N);

  const out = Array.from({ length: N }, () => new Float64Array(N));
  for (let x = 0; x < N; x++) {
    const col = new Float64Array(N);
    for (let y = 0; y < N; y++) col[y] = tmp[y][x];
    const cd = dct1(col, cos, N);
    for (let y = 0; y < N; y++) out[y][x] = cd[y];
  }
  return out;
}


export async function phash(src) {
  
  const img = await loadImage(src);
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32); 

  
  const N = 32;
  const mat = Array.from({ length: N }, (_, y) => {
    const row = new Uint8Array(N);
    for (let x = 0; x < N; x++) {
      const idx = 4 * (y * N + x);
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      row[x] = (r * 299 + g * 587 + b * 114) / 1000; 
    }
    return row;
  });

  
  const dct = dct2(mat, COS32, N);

  
  const coeff = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (x || y) coeff.push(dct[y][x]);
  const med = coeff.slice().sort((a, b) => a - b)[32];

  let hash = 0n;
  coeff.forEach(v => { hash = (hash << 1n) | (v > med ? 1n : 0n); });
  return hash.toString(16).padStart(16, '0');
}


function loadImage(source) {
  return new Promise((res, rej) => {
    if (source instanceof HTMLImageElement) return res(source);

    if (source instanceof OffscreenCanvas) {
      source.convertToBlob().then(blob => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = URL.createObjectURL(blob);
      }).catch(rej);
      return;
    }

    if (source instanceof HTMLCanvasElement) {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = source.toDataURL();
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = typeof source === 'string' ? source : URL.createObjectURL(source);
  });
}

