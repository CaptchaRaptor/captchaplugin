
const DEBUG = false;

const THR = {
  type : {
    default       : 0.50,
    hydrants      : 0.014,
    bridges       : 0.198,
    boats         : 0.516,
    cars          : 0.417,
    crosswalks    : 0.303,
    taxi          : 0.862,
    bicycles      : 0.041,
    trafficlights : 0.166,
    motorcycles   : 0.201,
    stairs        : 0.16,
    mountains     : 0.598,
    tractors      : 0.773,
    buses         : 0.158,
    palm          : 0.673,
    parkingmeter  : 0.846,
    chimney       : 0.372,
  },
};

// =========================
// ONNXRuntime (web)
// =========================
let ortP;
async function ort() {
  if (!ortP) {
    ortP = import(chrome.runtime.getURL('libs/onnxruntime-web/ort.esm.js')).catch(err => {
      console.error('[ort] Failed to load ONNX Runtime module:', err);
      ortP = undefined;
      throw err;
    });
  }
  return ortP;
}


const cache = new Map();  
const lock  = new WeakMap(); 

async function runSafe(sess, feeds) {
  const prev = lock.get(sess) || Promise.resolve();
  let unlock; const next = new Promise(r => (unlock = r));
  lock.set(sess, prev.then(() => next));
  await prev;
  try { return await sess.run(feeds); }
  finally { unlock(); }
}


const TYPE_MODEL_URL = chrome.runtime.getURL('models/type.onnx');


const TYPE_INDEX = Object.freeze({
  boats: 0,
  motorcycles: 1,
  palm: 2,
  parkingmeter: 3,
  stairs: 4,
  taxi: 5,
  tractors: 6,
  bicycles: 7,
  cars: 8,
  hydrants: 9,
  crosswalks: 10,
  buses: 11,
  trafficlights: 12, 
  bridges: 13,
  chimney: 14,       
  mountains: 15,
});

let typeSessionP; 

async function getTypeSession() {
  if (!typeSessionP) {
    const { InferenceSession } = await ort();
    typeSessionP = InferenceSession.create(
      TYPE_MODEL_URL,
      { executionProviders:['wasm'], graphOptimizationLevel:'all' }
    ).catch(err => {
      console.error('[getTypeSession] Failed to create type session:', err);
      typeSessionP = undefined;
      throw err;
    });
  }
  return typeSessionP;
}


const GRID_MODEL_URL = chrome.runtime.getURL('models/grid.onnx');
const GRID_META_URL  = chrome.runtime.getURL('models/grid.meta.json');

let gridSessionP; 
let gridMetaP;

async function getGridSession() {
  if (!gridSessionP) {
    const { InferenceSession } = await ort();
    gridSessionP = InferenceSession.create(
      GRID_MODEL_URL,
      { executionProviders:['wasm'], graphOptimizationLevel:'all' }
    ).catch(err => {
      console.error('[getGridSession] Failed to create grid session:', err);
      gridSessionP = undefined;
      throw err;
    });
  }
  return gridSessionP;
}

async function getGridMeta() {
  if (!gridMetaP) {
    gridMetaP = fetch(GRID_META_URL).then(async r => {
      if (!r.ok) throw new Error(`grid_meta_http_${r.status}`);
      const meta = await r.json();
      if (!meta?.type_to_index || !meta?.thresholds_by_type) {
        throw new Error('grid_meta_invalid_shape');
      }
      return meta;
    });
  }
  return gridMetaP;
}


const loadImg = b64 => new Promise((ok, err) => {
  const im = new Image(); im.onload = () => ok(im); im.onerror = err;
  im.src = `data:image/jpeg;base64,${b64}`;
});

async function imgToTensor(src, size) {
  const can = new OffscreenCanvas(size, size);
  const ctx = can.getContext('2d');
  ctx.drawImage(src, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const numPix = size * size;
  const f32 = new Float32Array(3 * numPix);

  const MEAN = [0.485, 0.456, 0.406];
  const STD  = [0.229, 0.224, 0.225];

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    f32[p]             = ((data[i]   / 255) - MEAN[0]) / STD[0]; // R
    f32[numPix + p]    = ((data[i+1] / 255) - MEAN[1]) / STD[1]; // G
    f32[2 * numPix+p]  = ((data[i+2] / 255) - MEAN[2]) / STD[2]; // B
  }

  const { Tensor } = await ort();
  return new Tensor('float32', f32, [1, 3, size, size]);
}

function split3x3(baseImg){
  const tiles=[];
  for(let r=0;r<3;r++) for(let c=0;c<3;c++){
    const cv = new OffscreenCanvas(100,100);
    cv.getContext('2d')
      .drawImage(baseImg,c*100,r*100,100,100,0,0,100,100);
    tiles.push(cv);
  }
  return tiles;
}


const sigmoid = x => 1 / (1 + Math.exp(-x));
function firstTensor(runRes){ return runRes[Object.keys(runRes)[0]]; }

function probForLabel(runRes, classIdx) {
  const logits = firstTensor(runRes).data; 
  return sigmoid(logits[classIdx]);
}


function probsGridForClass(runRes, classIdx) {
  const out = firstTensor(runRes);
  const logits = out.data;
  const HW = out.dims[2];
  const base = classIdx * HW;
  const arr = new Array(HW);
  for (let i = 0; i < HW; i++) {
    arr[i] = sigmoid(logits[base + i]);
  }
  return arr; 
}

const postGrid = (probs16, thr16) => probs16.map((p, i) => p > (thr16[i] ?? 0.5));


const ALIAS = {
  fire:'hydrants', firehydrant:'hydrants', 'fire_hydrant':'hydrants', hydrant:'hydrants',

  bicycle:'bicycles', bike:'bicycles',
  boat:'boats',
  bridge:'bridges',
  bus:'buses',
  car:'cars',
  chimney:'chimney', chimneys:'chimney',
  crosswalk:'crosswalks', zebra:'crosswalks',

  motorcycle:'motorcycles',
  mountain:'mountains',
  palm:'palm',
  parkingmeter:'parkingmeter', parking:'parkingmeter',
  stairs:'stairs', stair:'stairs',
  taxi:'taxi', taxis:'taxi',
  tractors:'tractors', tractor:'tractors',

  traffic:'trafficlights', trafficlight:'trafficlights', 'traffic_light':'trafficlights',
  trafficlights:'trafficlights', 'traffic_lights':'trafficlights',
};

const KNOWN = new Set([
  'bicycles','boats','bridges','buses','cars','chimney','crosswalks','hydrants',
  'motorcycles','mountains','palm','parkingmeter','stairs','taxi','tractors',
  'trafficlights'
]);

function extractLabel(txt){
  const m = String(txt).toLowerCase().match(/with\s+(?:an?\s+)?([a-z_]+)/);
  return m ? m[1] : String(txt).trim().toLowerCase().split(/\s+/).pop();
}
function normalizeLabel(raw){
  if(!raw) return null;
  const basic = (ALIAS[raw] ?? (raw.endsWith('s') ? raw : raw+'s'));
  return KNOWN.has(basic) ? basic : null;
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

// =========================

export async function recognizeRecaptcha(payload) {
  const { task, image_data: imgs, grid } = payload;
  if (!task || !imgs?.length) return { error: 'bad_payload' };

  const raw   = extractLabel(task);
  const label = normalizeLabel(raw);
  if (!label) return { error: `unsupported_label:${raw}` };

  const variant = grid === '4x4' ? 'grid' : 'type';

  let tensors = [];
  if (variant === 'grid') {
    const base = await loadImg(imgs[0]);
    const gridMeta = await getGridMeta();
    const gridSize = Number.isInteger(gridMeta?.image_size) ? gridMeta.image_size : 240;
    tensors = [await imgToTensor(base, gridSize)];
  } else if (grid === '3x3') {
    const base  = await loadImg(imgs[0]);
    const tiles = split3x3(base);
    tensors = await Promise.all(tiles.map(cv => imgToTensor(cv, 100)));
  } else {
    const imObjs = await Promise.all(imgs.map(loadImg));
    tensors = await Promise.all(imObjs.map(im => imgToTensor(im, 100)));
  }

  if (variant === 'type') {
    const thr = THR.type?.[label] ?? THR.type?.default ?? 0.5;
    
    const idx = TYPE_INDEX[label];
    if (idx == null) return { error: `unknown_class_in_type_model:${label}` };

    const sess = await getTypeSession();
    const outs = await Promise.all(tensors.map(t => runSafe(sess, { input: t })));

    const probs = outs.map(o => probForLabel(o, idx));
    const data  = probs.map(p => p > thr);

    if (DEBUG) {
      console.debug(`[AI] ${grid}/${label} probs`, probs);
      console.debug('[AI] selected', data);
    }
    return { data };
  }


  const gridMeta = await getGridMeta();
  const classIdx = gridMeta.type_to_index?.[label];
  if (classIdx == null) return { error: `unknown_class_in_grid_model:${label}` };
  const thr16 = gridMeta.thresholds_by_type?.[label];
  if (!Array.isArray(thr16) || thr16.length !== 16) {
    return { error: `bad_thresholds_for_grid_model:${label}` };
  }

  const gridSess = await getGridSession();
  const outs = await Promise.all(tensors.map(t => runSafe(gridSess, { input: t })));


  const probs16 = probsGridForClass(outs[0], classIdx); 
  let data      = postGrid(probs16, thr16);

  // 20% — la vida es un carrusel 
  if (Math.random() < 0.20) {
    data = data.map((v, i) => {
      const p = probs16[i];
      if (!v) return Math.random() < p;
      const flipProb = (1 - p) / 2;
      return !(Math.random() < flipProb);
    });
    if (DEBUG) console.debug('[AI] grid adjustment applied (20% case)');
  }


  if (grid === '4x4') {
    let count = 0;
    let firstIdx = -1;

    for (let i = 0; i < data.length; i++) {
      if (data[i]) { count++; firstIdx = i; }
    }

    if (count === 1) {
      let bestIdx = -1;
      let bestP = -Infinity;

      for (let i = 0; i < probs16.length; i++) {
        if (i === firstIdx) continue;
        const p = probs16[i];
        if (Number.isFinite(p) && p > bestP) {
          bestP = p;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) {
        if (data.length > 1) {
          do { bestIdx = Math.floor(Math.random() * data.length); }
          while (bestIdx === firstIdx);
        }
      }

      if (bestIdx !== -1) data[bestIdx] = true;
    }
  }

  if (DEBUG) {
    console.debug(`[AI] ${grid}/${label} probs16`, probs16);
    console.debug('[AI] selected', data);
  }
  return { data };
}
