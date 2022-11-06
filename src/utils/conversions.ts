export const toHex = (buffer: Uint8Array): string => {
  const data: string[] = [];
  buffer.map((x) => data.push(`00${x.toString(16)}`.slice(-2)));
  return data.join("");
};

export const intToBytearray = (i: number) => {
  return new Uint8Array([
    i & 0xff,
    (i >> 8) & 0xff,
    (i >> 16) & 0xff,
    (i >> 24) & 0xff
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
