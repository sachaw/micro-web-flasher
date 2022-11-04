import { TimeoutError } from './error.js';

export class Transport {
  public device: SerialPort;
  public slip_reader_enabled: boolean;
  public left_over: Uint8Array;
  public baudRate: number;

  constructor(device: SerialPort) {
    this.device = device;
    this.slip_reader_enabled = false;
    this.left_over = new Uint8Array(0);
    this.baudRate = 115200;
  }

  get_info() {
    const info = this.device.getInfo();
    return (
      "WebSerial VendorID 0x" +
      info.usbVendorId?.toString(16) +
      " ProductID 0x" +
      info.usbProductId?.toString(16)
    );
  }

  slip_writer(data: Uint8Array) {
    let count_esc = 0;
    let i = 0,
      j = 0;

    for (i = 0; i < data.length; i++) {
      if (data[i] === 0xc0 || data[i] === 0xdb) {
        count_esc++;
      }
    }
    const out_data = new Uint8Array(2 + count_esc + data.length);
    out_data[0] = 0xc0;
    j = 1;
    for (i = 0; i < data.length; i++, j++) {
      if (data[i] === 0xc0) {
        out_data[j++] = 0xdb;
        out_data[j] = 0xdc;
        continue;
      }
      if (data[i] === 0xdb) {
        out_data[j++] = 0xdb;
        out_data[j] = 0xdd;
        continue;
      }

      out_data[j] = data[i];
    }
    out_data[j] = 0xc0;
    return out_data;
  }

  async write(data: Uint8Array) {
    const writer = this.device.writable?.getWriter();
    const out_data = this.slip_writer(data);

    await writer?.write(new Uint8Array(out_data.buffer));
    writer?.releaseLock();
  }

  _appendBuffer(buffer1: Uint8Array, buffer2: Uint8Array) {
    const tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
    tmp.set(new Uint8Array(buffer1), 0);
    tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
    return tmp.buffer;
  }

  /* this function expects complete packet (hence reader reads for atleast 8 bytes. This function is
   * stateless and returns the first wellformed packet only after replacing escape sequence */
  slip_reader(data: Uint8Array) {
    let i = 0;
    let data_start = 0,
      data_end = 0;
    let state = "init";
    while (i < data.length) {
      if (state === "init" && data[i] == 0xc0) {
        data_start = i + 1;
        state = "valid_data";
        i++;
        continue;
      }
      if (state === "valid_data" && data[i] == 0xc0) {
        data_end = i - 1;
        state = "packet_complete";
        break;
      }
      i++;
    }
    if (state !== "packet_complete") {
      this.left_over = data;
      return new Uint8Array(0);
    }

    this.left_over = data.slice(data_end + 2);
    let temp_pkt = new Uint8Array(data_end - data_start + 1);
    let j = 0;
    for (i = data_start; i <= data_end; i++, j++) {
      if (data[i] === 0xdb && data[i + 1] === 0xdc) {
        temp_pkt[j] = 0xc0;
        i++;
        continue;
      }
      if (data[i] === 0xdb && data[i + 1] === 0xdd) {
        temp_pkt[j] = 0xdb;
        i++;
        continue;
      }
      temp_pkt[j] = data[i];
    }
    return temp_pkt.slice(0, j); /* Remove unused bytes due to escape seq */
  }

  async read({ timeout = 0, min_data = 12 } = {}) {
    console.log("Read with timeout " + timeout);
    let t;
    let packet = this.left_over;
    this.left_over = new Uint8Array(0);
    if (this.slip_reader_enabled) {
      const val_final = this.slip_reader(packet);
      if (val_final.length > 0) {
        return val_final;
      }
      packet = this.left_over;
      this.left_over = new Uint8Array(0);
    }

    const reader = this.device.readable?.getReader();
    if (!reader) {
      throw new Error("reader not defined"); //TODO: make specific error.
    }
    try {
      if (timeout > 0) {
        t = setTimeout(function () {
          reader.cancel();
        }, timeout);
      }
      do {
        const { value, done } = await reader.read();
        if (done) {
          this.left_over = packet;
          throw new TimeoutError("Timeout");
        }
        packet = new Uint8Array(
          this._appendBuffer(
            new Uint8Array(packet.buffer),
            new Uint8Array(value.buffer)
          )
        );
      } while (packet.length < min_data);
    } finally {
      if (timeout > 0) {
        clearTimeout(t);
      }
      reader.releaseLock();
    }
    if (this.slip_reader_enabled) {
      return this.slip_reader(packet);
    }
    return packet;
  }

  async rawRead({ timeout = 0 } = {}) {
    if (this.left_over.length != 0) {
      const p = this.left_over;
      this.left_over = new Uint8Array(0);
      return p;
    }
    const reader = this.device.readable?.getReader();
    if (!reader) {
      throw new Error("reader not defined"); //TODO: make specific error.
    }
    let t;
    try {
      if (timeout > 0) {
        t = setTimeout(function () {
          reader.cancel();
        }, timeout);
      }
      const { value, done } = await reader.read();
      if (done) {
        throw new TimeoutError("Timeout");
      }
      return value;
    } finally {
      if (timeout > 0) {
        clearTimeout(t);
      }
      reader.releaseLock();
    }
  }

  async setRTS(state: boolean) {
    await this.device.setSignals({ requestToSend: state });
  }

  async setDTR(state: boolean) {
    await this.device.setSignals({ dataTerminalReady: state });
  }

  async connect({ baud = 115200 } = {}) {
    await this.device.open({ baudRate: baud });
    this.baudRate = baud;
    this.left_over = new Uint8Array(0);
  }

  async disconnect() {
    await this.device.close();
  }
}
