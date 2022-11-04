export const toHex = (buffer: Uint8Array) => {
  return Array.prototype.map
    .call(buffer, (x) => ("00" + x.toString(16)).slice(-2))
    .join("");
};

export const intToBytearray = (i: number) => {
  return new Uint8Array([
    i & 0xff,
    (i >> 8) & 0xff,
    (i >> 16) & 0xff,
    (i >> 24) & 0xff,
  ]);
};

export const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const shortToBytearray = (i: number) => {
  return [i & 0xff, (i >> 8) & 0xff];
};

export const bytearrayToShort = (i: number, j: number) => {
  return i | (j >> 8);
};

export const bytearrayToInt = (i: number, j: number, k: number, l: number) => {
  return i | (j << 8) | (k << 16) | (l << 24);
};

//TODO: dupe methods?
export const appendBuffer = (buffer1: Uint8Array, buffer2: Uint8Array) => {
  const tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp.buffer;
};

//TODO: dupe methods?
export const appendArray = (arr1: Uint8Array, arr2: Uint8Array) => {
  const c = new Uint8Array(arr1.length + arr2.length);
  c.set(arr1, 0);
  c.set(arr2, arr1.length);
  return c;
};

export const ui8ToBstr = (u8Array: Uint8Array) => {
  const len = u8Array.length;
  let b_str = "";
  for (let i = 0; i < len; i++) {
    b_str += String.fromCharCode(u8Array[i]);
  }
  return b_str;
};

export const bstrToUi8 = (bStr: string) => {
  const len = bStr.length;
  const u8_array = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    u8_array[i] = bStr.charCodeAt(i);
  }
  return u8_array;
};

export const checksum = (data: Uint8Array) => {
  let chk = 0xef;

  for (let i = 0; i < data.length; i++) {
    chk ^= data[i];
  }
  return chk;
};
