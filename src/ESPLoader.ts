import { deflate, inflate } from "pako";
import { Logger } from "tslog";

import { ESPError, TimeoutError } from "./error.js";
import { BaseDevice } from "./targets/base.js";
import { ESP32ROM } from "./targets/esp32.js";
import { ESP32C3ROM } from "./targets/esp32c3.js";
import { ESP32S2ROM } from "./targets/esp32s2.js";
import { ESP32S3ROM } from "./targets/esp32s3.js";
import {
  bstrToUi8,
  bytearrayToInt,
  checksum,
  intToBytearray,
  shortToBytearray,
  sleep,
  toHex
} from "./utils/conversions.js";
import { Transport } from "./webserial.js";

const magicToChip = new Map<number, BaseDevice>([
  [0x00f01d83, new ESP32ROM()],
  [0x6921506f, new ESP32C3ROM()], // ESP32C3 eco 1+2
  [0x1b31506f, new ESP32C3ROM()], // ESP32C3 eco3
  [0x09, new ESP32S3ROM()], //
  [0x000007c6, new ESP32S2ROM()]
]);

export interface fileType {
  data: Uint8Array;
  address: number;
}

export enum deviceCmd {
  ESP_FLASH_BEGIN = 0x02,
  ESP_FLASH_DATA = 0x03,
  ESP_FLASH_END = 0x04,
  ESP_MEM_BEGIN = 0x05,
  ESP_MEM_END = 0x06,
  ESP_MEM_DATA = 0x07,
  ESP_WRITE_REG = 0x09,
  ESP_READ_REG = 0x0a
}

export class ESPLoader {
  public logger: Logger<unknown>;

  public ESP_RAM_BLOCK = 0x1800;

  public ESP_SPI_ATTACH = 0x0d;
  public ESP_CHANGE_BAUDRATE = 0x0f;
  public ESP_FLASH_DEFL_BEGIN = 0x10;
  public ESP_FLASH_DEFL_DATA = 0x11;
  public ESP_FLASH_DEFL_END = 0x12;
  public ESP_SPI_FLASH_MD5 = 0x13;

  // Only Stub supported commands
  public ESP_ERASE_FLASH = 0xd0;
  public ESP_ERASE_REGION = 0xd1;
  public ESP_RUN_USER_CODE = 0xd3;

  public ESP_IMAGE_MAGIC = 0xe9;
  public ESP_CHECKSUM_MAGIC = 0xef;

  // Response code(s) sent by ROM
  public ROM_INVALID_RECV_MSG = 0x05; // response if an invalid message is received

  public ERASE_REGION_TIMEOUT_PER_MB = 30000;
  public ERASE_WRITE_TIMEOUT_PER_MB = 40000;
  public MD5_TIMEOUT_PER_MB = 8000;
  public CHIP_ERASE_TIMEOUT = 120000;
  public MAX_TIMEOUT = this.CHIP_ERASE_TIMEOUT * 2;

  public CHIP_DETECT_MAGIC_REG_ADDR = 0x40001000;

  public DETECTED_FLASH_SIZES = new Map([
    [0x12, "256KB"],
    [0x13, "512KB"],
    [0x14, "1MB"],
    [0x15, "2MB"],
    [0x16, "4MB"],
    [0x17, "8MB"],
    [0x18, "16MB"]
  ]);

  public transport: Transport;
  public baudrate: number;
  public IS_STUB: boolean;
  public chip?: BaseDevice;
  public FLASH_WRITE_SIZE: number;

  constructor(transport: Transport, baudrate: number) {
    this.logger = new Logger({});
    this.transport = transport;
    this.baudrate = baudrate;
    this.IS_STUB = false;
    this.chip = undefined; //TODO: was null

    // TODO: wasn't here
    this.FLASH_WRITE_SIZE = 0;

    console.log("esptool.js v0.1-dev");
    console.log(`Serial port ${this.transport.get_info()}`);
  }

  public async flushInput() {
    try {
      await this.transport.rawRead(200);
    } catch (e) {
      console.log(e);
    }
  }

  public async command(
    op: number | undefined,
    data: Uint8Array,
    chk: number,
    waitResponse = true,
    timeout = 3000
  ): Promise<[number, Uint8Array]> {
    //console.log("command "+ op + " " + waitResponse + " " + timeout);
    if (op != null) {
      const pkt = new Uint8Array(8 + data.length);
      pkt[0] = 0x00;
      pkt[1] = op;
      pkt[2] = shortToBytearray(data.length)[0];
      pkt[3] = shortToBytearray(data.length)[1];
      pkt[4] = intToBytearray(chk)[0];
      pkt[5] = intToBytearray(chk)[1];
      pkt[6] = intToBytearray(chk)[2];
      pkt[7] = intToBytearray(chk)[3];

      for (let i = 0; i < data.length; i++) {
        pkt[8 + i] = data[i];
      }
      //console.log("Command " + pkt);
      await this.transport.write(pkt);
    }

    if (waitResponse) {
      // Check up-to next 100 packets for valid response packet
      for (let i = 0; i < 100; i++) {
        const p = await this.transport.read({ timeout: timeout });
        //console.log("Response " + p);
        const resp = p[0];
        const opRet = p[1];
        // const len_ret = this._bytearray_to_short(p[2], p[3]);
        const val = bytearrayToInt(p[4], p[5], p[6], p[7]);
        //console.log("Resp "+resp + " " + op_ret + " " + len_ret + " " + val );
        const data = p.slice(8);
        if (resp == 1) {
          if (op == null || opRet == op) {
            return [val, data];
          } else if (data[0] != 0 && data[1] == this.ROM_INVALID_RECV_MSG) {
            this.flushInput();
            throw new ESPError("unsupported command error");
          }
        }
      }
      throw new ESPError("invalid response");
    }
    throw new Error("Fell through"); //TODO: Workaround
  }

  public async readRegister(address: number, timeout = 3000) {
    const pkt = intToBytearray(address);
    const val = await this.command(
      deviceCmd.ESP_READ_REG,
      pkt,
      0, //TODO: wasn't here
      true, //TODO: Wasn't here
      timeout
    );
    return val[0];
  }

  public async writeRegister(
    address: number,
    value: number,
    mask = 0xffffffff,
    delayUs = 0,
    delayAfterUs = 0
  ) {
    if (!this.chip) {
      throw new Error("chip not defined"); //TODO: make specific error.
    }
    let pkt = new Uint8Array([
      ...intToBytearray(address),
      ...intToBytearray(value),
      ...intToBytearray(mask),
      ...intToBytearray(delayUs)
    ]);

    if (delayAfterUs > 0) {
      pkt = new Uint8Array([
        ...pkt,
        ...intToBytearray(this.chip.UART_DATE_REG_ADDR ?? 0),
        ...pkt,
        ...intToBytearray(0),
        ...intToBytearray(0),
        ...intToBytearray(delayAfterUs)
      ]); //TODO: no default before
    }

    await this.checkCommand(
      deviceCmd.ESP_WRITE_REG,
      pkt,
      0,
      "write target memory"
    );
  }

  public async sync() {
    const command = new Uint8Array(36);

    command[0] = 0x07;
    command[1] = 0x07;
    command[2] = 0x12;
    command[3] = 0x20;
    for (let i = 0; i < 32; i++) {
      command[4 + i] = 0x55;
    }

    try {
      const response = await this.command(0x08, command, 0, true, 100);
      return response;
    } catch (e) {
      console.log(`Sync err ${e}`);
      throw e;
    }
  }

  private async connectAttempt(mode = "default_reset", esp32r0Delay: boolean) {
    console.log(`_connect_attempt ${mode} ${esp32r0Delay}`);
    if (mode !== "no_reset") {
      await this.transport.setDTR(false);
      await this.transport.setRTS(true);
      await sleep(100);
      if (esp32r0Delay) {
        //await sleep(1200);
        await sleep(2000);
      }
      await this.transport.setDTR(true);
      await this.transport.setRTS(false);
      if (esp32r0Delay) {
        //await sleep(400);
      }
      await sleep(50);
      await this.transport.setDTR(false);
    }
    let i = 0;
    while (1) {
      try {
        const res = await this.transport.read({ timeout: 2000 });
        i += res.length;
        //console.log("Len = " + res.length);
        //const str = new TextDecoder().decode(res);
        //console.log(str);
      } catch (e) {
        if (e instanceof TimeoutError) {
          break;
        }
      }
      await sleep(50);
    }
    this.transport.slip_reader_enabled = true;
    i = 7;
    while (i--) {
      try {
        const response = await this.sync();
        return "success";
      } catch (error) {
        if (error instanceof TimeoutError) {
          console.log("timed out");
        }
      }
      await sleep(50);
    }
    return "error";
  }

  public async connect(mode?: string, attempts = 7, detecting = false) {
    let resp;
    this.chip = undefined;
    console.log("Connecting...");
    await this.transport.connect();
    for (let i = 0; i < attempts; i++) {
      resp = await this.connectAttempt(mode, false);
      if (resp === "success") {
        break;
      }
      resp = await this.connectAttempt(mode, true);
      if (resp === "success") {
        break;
      }
    }
    if (resp !== "success") {
      throw new ESPError("Failed to connect with the device");
    }
    this.flushInput();

    if (!detecting) {
      const chipMagicValue = (await this.readRegister(0x40001000)) >>> 0;
      console.log(`Chip Magic ${chipMagicValue.toString(16)}`);

      if (magicToChip.has(chipMagicValue)) {
        this.chip = magicToChip.get(chipMagicValue);
      } else {
        throw new ESPError(
          `Unexpected CHIP magic value ${chipMagicValue}. Failed to autodetect chip type.`
        );
      }
    }
  }

  public async detectChip() {
    await this.connect();
    console.log("Detecting chip type... ");
    if (this.chip != null) {
      console.log(this.chip.CHIP_NAME);
    }
  }

  public async checkCommand(
    op: number,
    data: Uint8Array,
    chk: number,
    opDescription: string,
    timeout = 3000
  ) {
    console.log(`checkCommand ${opDescription}`);
    const resp = await this.command(op, data, chk, true, timeout);
    if (resp[1].length > 4) {
      return resp[1];
    } else {
      return new Uint8Array(resp[0]);
    }
  }

  public async memBegin(
    size: number,
    blocks: number,
    blocksize: number,
    offset: number
  ) {
    /* XXX: Add check to ensure that STUB is not getting overwritten */
    console.log(
      `mem_begin ${size} ${blocks} ${blocksize} ${offset.toString(16)}`
    );
    const pkt = new Uint8Array([
      ...intToBytearray(size),
      ...intToBytearray(blocks),
      ...intToBytearray(blocksize),
      ...intToBytearray(offset)
    ]);
    await this.checkCommand(
      deviceCmd.ESP_MEM_BEGIN,
      pkt,
      0,
      "enter RAM download mode"
    );
  }

  public async memBlock(buffer: Uint8Array, seq: number) {
    const pkt = new Uint8Array([
      ...intToBytearray(buffer.length),
      ...intToBytearray(seq),
      ...intToBytearray(0),
      ...intToBytearray(0),
      ...buffer
    ]);

    await this.checkCommand(
      deviceCmd.ESP_MEM_DATA,
      pkt,
      checksum(buffer),
      "write to target RAM"
    );
  }

  public async memFinish(entrypoint: number) {
    const isEntry = entrypoint === 0 ? 1 : 0;
    const pkt = new Uint8Array([
      ...intToBytearray(isEntry),
      ...intToBytearray(entrypoint)
    ]);
    await this.checkCommand(
      deviceCmd.ESP_MEM_END,
      pkt,
      0,
      "leave RAM download mode",
      50
    ); // XXX: handle non-stub with diff timeout
  }

  public async flashSpiAttach(hspiArg: number) {
    const pkt = intToBytearray(hspiArg);
    await this.checkCommand(
      this.ESP_SPI_ATTACH,
      pkt,
      0,
      "configure SPI flash pins"
    );
  }

  public timeoutPerMb(secondsPerMb: number, sizeBytes: number) {
    const result = secondsPerMb * (sizeBytes / 1000000);

    return result < 3000 ? 3000 : result;
  }

  public async flashBegin(size: number, offset: number) {
    if (!this.chip) {
      throw new Error("chip not defined"); //TODO: make specific error.
    }

    const numBlocks = Math.floor(
      (size + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE
    );
    const eraseSize = this.chip.get_erase_size(offset, size);

    const d = new Date();
    const t1 = d.getTime();

    let timeout = 3000;
    if (!this.IS_STUB) {
      timeout = this.timeoutPerMb(this.ERASE_REGION_TIMEOUT_PER_MB, size);
    }

    console.log(
      `flash begin ${eraseSize} ${numBlocks} ${this.FLASH_WRITE_SIZE} ${offset} ${size}`
    );
    let pkt = new Uint8Array([
      ...intToBytearray(eraseSize),
      ...intToBytearray(numBlocks),
      ...intToBytearray(this.FLASH_WRITE_SIZE),
      ...intToBytearray(offset)
    ]);
    if (!this.IS_STUB) {
      pkt = new Uint8Array([...pkt, ...intToBytearray(0)]); // XXX: Support encrypted
    }

    await this.checkCommand(
      deviceCmd.ESP_FLASH_BEGIN,
      pkt,
      0,
      "enter Flash download mode",
      timeout
    );

    const t2 = d.getTime();
    if (size !== 0 && !this.IS_STUB) {
      console.log(
        `Took ${(t2 - t1) / 1000}.${(t2 - t1) % 1000}s to erase flash block`
      );
    }
    return numBlocks;
  }

  public async flashDeflBegin(size: number, compsize: number, offset: number) {
    if (!this.chip) {
      throw new Error("chip not defined"); //TODO: make specific error.
    }
    const numBlocks = Math.floor(
      (compsize + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE
    );
    const eraseBlocks = Math.floor(
      (size + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE
    );

    const d = new Date();
    const t1 = d.getTime();

    let writeSize, timeout;
    if (this.IS_STUB) {
      writeSize = size;
      timeout = 3000;
    } else {
      writeSize = eraseBlocks * this.FLASH_WRITE_SIZE;
      timeout = this.timeoutPerMb(this.ERASE_REGION_TIMEOUT_PER_MB, writeSize);
    }
    console.log(`Compressed ${size} bytes to ${compsize}`);

    let pkt = new Uint8Array([
      ...intToBytearray(writeSize),
      ...intToBytearray(numBlocks),
      ...intToBytearray(this.FLASH_WRITE_SIZE),
      ...intToBytearray(offset)
    ]);

    if (
      (this.chip.CHIP_NAME === "ESP32-S2" ||
        this.chip.CHIP_NAME === "ESP32-S3" ||
        this.chip.CHIP_NAME === "ESP32-C3") &&
      !this.IS_STUB
    ) {
      pkt = new Uint8Array([...pkt, ...intToBytearray(0)]);
    }
    await this.checkCommand(
      this.ESP_FLASH_DEFL_BEGIN,
      pkt,
      0,
      "enter compressed flash mode",
      timeout
    );
    const t2 = d.getTime();
    if (size != 0 && !this.IS_STUB) {
      console.log(
        `Took ${(t2 - t1) / 1000}.${(t2 - t1) % 1000}s to erase flash block`
      );
    }
    return numBlocks;
  }

  public async flashBlock(data: Uint8Array, seq: number, timeout: number) {
    const pkt = new Uint8Array([
      ...intToBytearray(data.length),
      ...intToBytearray(seq),
      ...intToBytearray(0),
      ...intToBytearray(0),
      ...data
    ]);

    await this.checkCommand(
      deviceCmd.ESP_FLASH_DATA,
      pkt,
      checksum(data),
      `write to target Flash after seq ${seq}`,
      timeout
    );
  }

  public async flashDeflBlock(data: Uint8Array, seq: number, timeout: number) {
    const pkt = new Uint8Array([
      ...intToBytearray(data.length),
      ...intToBytearray(seq),
      ...intToBytearray(0),
      ...intToBytearray(0),
      ...data
    ]);

    console.log(
      `flashDeflBlock ${data[0].toString(16)} ${data[1].toString(16)}`
    );

    await this.checkCommand(
      this.ESP_FLASH_DEFL_DATA,
      pkt,
      checksum(data),
      `write compressed data to flash after seq ${seq}`,
      timeout
    );
  }

  public async flashFinish(reboot: boolean) {
    const val = reboot ? 0 : 1;
    const pkt = intToBytearray(val);

    await this.checkCommand(
      deviceCmd.ESP_FLASH_END,
      pkt,
      0,
      "leave Flash mode"
    );
  }

  public async flashDeflFinish(reboot: boolean) {
    const val = reboot ? 0 : 1;
    const pkt = intToBytearray(val);

    await this.checkCommand(
      this.ESP_FLASH_DEFL_END,
      pkt,
      0,
      "leave compressed flash mode"
    );
  }

  public async runSpiflashCommand(
    spiflashCommand: number,
    data: Uint8Array,
    readBits: number
  ) {
    if (!this.chip) {
      throw new Error("chip not defined"); //TODO: make specific error.
    }

    // SPI_USR register flags
    const SPI_USR_COMMAND = 1 << 31;
    const SPI_USR_MISO = 1 << 28;
    const SPI_USR_MOSI = 1 << 27;

    // SPI registers, base address differs ESP32* vs 8266
    const base = this.chip.SPI_REG_BASE;
    const SPI_CMD_REG = base + 0x00;
    const SPI_USR_REG = base + this.chip.SPI_USR_OFFS;
    const SPI_USR1_REG = base + this.chip.SPI_USR1_OFFS;
    const SPI_USR2_REG = base + this.chip.SPI_USR2_OFFS;
    const SPI_W0_REG = base + this.chip.SPI_W0_OFFS;

    let setDataLengths;
    if (this.chip.SPI_MOSI_DLEN_OFFS != null) {
      setDataLengths = async (mosiBits: number, misoBits: number) => {
        if (!this.chip) {
          throw new Error("chip not defined"); //TODO: make specific error.
        }
        const SPI_MOSI_DLEN_REG = base + (this.chip.SPI_MOSI_DLEN_OFFS ?? 0); //TODO: no default before
        const SPI_MISO_DLEN_REG = base + (this.chip.SPI_MISO_DLEN_OFFS ?? 0); //TODO: no default before
        if (mosiBits > 0) {
          await this.writeRegister(SPI_MOSI_DLEN_REG, mosiBits - 1);
        }
        if (misoBits > 0) {
          await this.writeRegister(SPI_MISO_DLEN_REG, misoBits - 1);
        }
      };
    } else {
      setDataLengths = async (mosiBits: number, misoBits: number) => {
        const SPI_DATA_LEN_REG = SPI_USR1_REG;
        const SPI_MOSI_BITLEN_S = 17;
        const SPI_MISO_BITLEN_S = 8;
        const mosi_mask = mosiBits === 0 ? 0 : mosiBits - 1;
        const miso_mask = misoBits === 0 ? 0 : misoBits - 1;
        const val =
          (miso_mask << SPI_MISO_BITLEN_S) | (mosi_mask << SPI_MOSI_BITLEN_S);
        await this.writeRegister(SPI_DATA_LEN_REG, value);
      };
    }

    const SPI_CMD_USR = 1 << 18;
    const SPI_USR2_COMMAND_LEN_SHIFT = 28;
    if (readBits > 32) {
      throw new ESPError(
        "Reading more than 32 bits back from a SPI flash operation is unsupported"
      );
    }
    if (data.length > 64) {
      throw new ESPError(
        "Writing more than 64 bytes of data with one SPI command is unsupported"
      );
    }

    const dataBits = data.length * 8;
    const oldSpiUsr = await this.readRegister(SPI_USR_REG);
    const oldSpiUsr2 = await this.readRegister(SPI_USR2_REG);
    let flags = SPI_USR_COMMAND;

    if (readBits > 0) {
      flags |= SPI_USR_MISO;
    }
    if (dataBits > 0) {
      flags |= SPI_USR_MOSI;
    }
    let i = 0;
    await setDataLengths(dataBits, readBits);
    await this.writeRegister(SPI_USR_REG, flags);
    let value = (7 << SPI_USR2_COMMAND_LEN_SHIFT) | spiflashCommand;
    await this.writeRegister(SPI_USR2_REG, value);
    if (dataBits == 0) {
      await this.writeRegister(SPI_W0_REG, 0);
    } else {
      if (data.length % 4 != 0) {
        const padding = new Uint8Array(data.length % 4);
        data = new Uint8Array([...data, ...padding]);
      }
      let nextRegister = SPI_W0_REG;
      for (i = 0; i < data.length - 4; i += 4) {
        value = bytearrayToInt(data[i], data[i + 1], data[i + 2], data[i + 3]);
        await this.writeRegister(nextRegister, value);
        nextRegister += 4;
      }
    }
    await this.writeRegister(SPI_CMD_REG, SPI_CMD_USR);
    for (i = 0; i < 10; i++) {
      value = (await this.readRegister(SPI_CMD_REG)) & SPI_CMD_USR;
      if (value == 0) {
        break;
      }
    }
    if (i === 10) {
      throw new ESPError("SPI command did not complete in time");
    }
    const stat = await this.readRegister(SPI_W0_REG);
    await this.writeRegister(SPI_USR_REG, oldSpiUsr);
    await this.writeRegister(SPI_USR2_REG, oldSpiUsr2);
    return stat;
  }

  public async readFlashId() {
    const SPIFLASH_RDID = 0x9f;
    const pkt = new Uint8Array(0);
    const flashId = await this.runSpiflashCommand(SPIFLASH_RDID, pkt, 24);
    const flidLowbyte = (flashId >> 16) & 0xff;

    return {
      manufacturer: (flashId & 0xff).toString(16),
      device: `${((flashId >> 8) & 0xff).toString(16)}${flidLowbyte.toString(
        16
      )}`,
      flashSize: this.DETECTED_FLASH_SIZES.get(flidLowbyte)
    };
  }

  public async eraseFlash() {
    console.log("Erasing flash (this may take a while)...");
    let d = new Date();
    const t1 = d.getTime();
    const ret = await this.checkCommand(
      this.ESP_ERASE_FLASH,
      new Uint8Array(),
      0,
      "erase flash",
      this.CHIP_ERASE_TIMEOUT
    );
    d = new Date();
    const t2 = d.getTime();
    console.log(`Chip erase completed successfully in ${(t2 - t1) / 1000}s`);
    return ret;
  }

  public async flashMd5Sum(addr: number, size: number) {
    const timeout = this.timeoutPerMb(this.MD5_TIMEOUT_PER_MB, size);
    const pkt = new Uint8Array([
      ...intToBytearray(addr),
      ...intToBytearray(size),
      ...intToBytearray(0),
      ...intToBytearray(0)
    ]);

    let res = await this.checkCommand(
      this.ESP_SPI_FLASH_MD5,
      pkt,
      0,
      "calculate md5sum",
      timeout
    );
    if (res.length > 16) {
      res = res.slice(0, 16);
    }
    const strmd5 = toHex(res);
    return strmd5;
  }

  public async runStub() {
    console.log("Uploading stub...");
    if (!this.chip) {
      throw new Error("chip not defined"); //TODO: make specific error.
    }

    let decoded = atob(this.chip.ROM_TEXT);
    let chardata = decoded.split("").map(function (x) {
      return x.charCodeAt(0);
    });
    const bindata = new Uint8Array(chardata);
    const text = inflate(bindata);

    decoded = atob(this.chip.ROM_DATA);
    chardata = decoded.split("").map(function (x) {
      return x.charCodeAt(0);
    });
    const data = new Uint8Array(chardata);

    let blocks = Math.floor(
      (text.length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK
    );

    await this.memBegin(
      text.length,
      blocks,
      this.ESP_RAM_BLOCK,
      this.chip.TEXT_START
    );
    for (let i = 0; i < blocks; i++) {
      const fromOffset = i * this.ESP_RAM_BLOCK;
      const toOffset = fromOffset + this.ESP_RAM_BLOCK;
      await this.memBlock(text.slice(fromOffset, toOffset), i);
    }

    blocks = Math.floor(
      (data.length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK
    );
    await this.memBegin(
      data.length,
      blocks,
      this.ESP_RAM_BLOCK,
      this.chip.DATA_START
    );
    for (let i = 0; i < blocks; i++) {
      const fromOffset = i * this.ESP_RAM_BLOCK;
      const toOffset = fromOffset + this.ESP_RAM_BLOCK;
      await this.memBlock(data.slice(fromOffset, toOffset), i);
    }

    console.log("Running stub...");
    await this.memFinish(this.chip.ENTRY);

    // Check up-to next 100 packets to see if stub is running
    for (let i = 0; i < 100; i++) {
      const res = await this.transport.read({ timeout: 1000, min_data: 6 });
      if (res[0] === 79 && res[1] === 72 && res[2] === 65 && res[3] === 73) {
        console.log("Stub running...");
        this.IS_STUB = true;
        this.FLASH_WRITE_SIZE = 0x4000;
        return this.chip;
      }
    }
    throw new ESPError("Failed to start stub. Unexpected response");
  }

  public async changeBaud() {
    console.log(`Changing baudrate to ${this.baudrate}`);
    const secondArg = this.IS_STUB ? this.transport.baudRate : 0;
    const pkt = new Uint8Array([
      ...intToBytearray(this.baudrate),
      ...intToBytearray(secondArg)
    ]);
    const resp = await this.command(this.ESP_CHANGE_BAUDRATE, pkt, 0, true);
    console.log("Changed");
    await this.transport.disconnect();
    await sleep(50);
    await this.transport.connect({ baud: this.baudrate });
    try {
      await this.transport.rawRead(500);
    } catch (e) {
      console.log(e);
    }
  }

  public async initialize() {
    await this.detectChip();
    if (!this.chip) {
      throw new Error("chip not defined"); //TODO: make specific error.
    }
    const chip = await this.chip.getChipDescription(this);
    console.log(`Chip is ${chip}`);
    console.log(`Features: ${await this.chip.getChipFeatures(this)}`);
    console.log(`Crystal is ${await this.chip.getCrystalFreq(this)} MHz`);
    console.log(`MAC: ${await this.chip.readMac(this)}`);
    await this.chip.readMac(this);

    if (typeof this.chip.postConnect != "undefined") {
      await this.chip.postConnect(this);
    }

    await this.runStub();

    await this.changeBaud();
    return chip;
  }

  public flashSizeBytes(flashSize: string) {
    let flashSizeB = -1;
    if (flashSize.includes("KB")) {
      flashSizeB = parseInt(flashSize.slice(0, flashSize.indexOf("KB"))) * 1024;
    } else if (flashSize.includes("MB")) {
      flashSizeB =
        parseInt(flashSize.slice(0, flashSize.indexOf("MB"))) * 1024 * 1024;
    }
    return flashSizeB;
  }

  public parseFlashSizeArg(flsz: string) {
    if (!this.chip) {
      throw new Error("chip not defined"); //TODO: make specific error.
    }
    if (typeof this.chip.FLASH_SIZES.get(flsz) === "undefined") {
      throw new ESPError(
        `Flash size ${flsz} is not supported by this chip type.`
      );
    }
    return this.chip.FLASH_SIZES.get(flsz);
  }

  private updateImageFlashParams(
    image: string,
    address: number,
    flashSize: string,
    flashMode: string,
    flashFreq: string,
    keepFlashSize?: boolean,
    keepFlashMode?: boolean,
    keepFlashFreq?: boolean
  ) {
    if (!this.chip) {
      throw new Error("chip not defined"); //TODO: make specific error.
    }
    console.log(
      `UpdateImageFlashParams ${flashSize} ${flashMode} ${flashFreq}`
    );
    if (image.length < 8) {
      return image;
    }
    if (address != this.chip.BOOTLOADER_FLASH_OFFSET) {
      return image;
    }
    if (
      keepFlashSize === true &&
      keepFlashMode === true &&
      keepFlashFreq === true
    ) {
      console.log("Not changing the image");
      return image;
    }

    const magic = image[0];
    let aFlashMode = parseInt(image[2]); //TODO: parseInt wasn't here before
    const flashSizeFreq = parseInt(image[3]); //TODO: parseInt wasn't here before
    if (parseInt(magic) !== this.ESP_IMAGE_MAGIC) {
      //TODO: parseInt wasn't here before
      console.log(
        `Warning: Image file at 0x${address.toString(
          16
        )} doesn't look like an image file, so not changing any flash settings.`
      );
      return image;
    }

    /* XXX: Yet to implement actual image verification */

    if (!keepFlashMode) {
      const flashModes = new Map([
        ["qio", 0],
        ["qout", 1],
        ["dio", 2],
        ["dout", 3]
      ]); //todo: may need to be inverted
      aFlashMode = flashModes.get(flashMode) ?? 0; //TODO: didn't have default previously
    }
    let aFlashFreq = flashSizeFreq & 0x0f;
    if (!keepFlashFreq) {
      const flashFreqs = new Map([
        ["40m", 0],
        ["26m", 1],
        ["20m", 2],
        ["80m", 0xf]
      ]);
      aFlashFreq = flashFreqs.get(flashFreq) ?? 0; //TODO: didn't have default previously
    }
    let aFlashSize = flashSizeFreq & 0xf0;
    if (!keepFlashSize) {
      aFlashSize = this.parseFlashSizeArg(flashSize) ?? 0; //TODO: didn't have default previously
    }

    const flashParams = (aFlashMode << 8) | (aFlashFreq + aFlashSize);
    console.log(`Flash params set to ${flashParams.toString(16)}`);
    if (parseInt(image[2]) !== aFlashMode << 8) {
      //@ts-ignore-next-line
      image[2] = aFlashMode << 8;
    }
    if (parseInt(image[3]) !== aFlashFreq + aFlashSize) {
      //@ts-ignore-next-line
      image[3] = aFlashFreq + aFlashSize;
    }
    return image;
  }

  public async writeFlash(
    fileArray: fileType[],
    flashSize: string,
    keepFlashSize = true,
    flashMode: string,
    flashFreq: string,
    eraseAll = false,
    compress = true,
    reportProgress:
      | ((fileIndex: number, written: number, totalBytes: number) => void)
      | undefined = undefined,
    calculateMD5Hash: ((image: string) => string) | undefined = undefined
  ) {
    console.log("EspLoader program");
    if (keepFlashSize) {
      const flashEnd = this.flashSizeBytes(flashSize);
      for (let i = 0; i < fileArray.length; i++) {
        if (fileArray[i].data.length + fileArray[i].address > flashEnd) {
          throw new ESPError(
            `File ${i + 1} doesn't fit in the available flash`
          );
        }
      }
    }

    if (this.IS_STUB && eraseAll) {
      await this.eraseFlash();
    }
    let image, address;
    for (let i = 0; i < fileArray.length; i++) {
      console.log(`Data Length ${fileArray[i].data.length}`);
      image =
        fileArray[i].data +
        "\xff\xff\xff\xff".substring(0, 4 - (fileArray[i].data.length % 4));
      address = fileArray[i].address;
      console.log(`Image Length ${image.length}`);
      if (image.length === 0) {
        console.log("Warning: File is empty");
        continue;
      }
      image = this.updateImageFlashParams(
        image,
        address,
        flashSize,
        flashMode,
        flashFreq
      );
      let calcmd5;
      if (calculateMD5Hash) {
        calcmd5 = calculateMD5Hash(image);
        console.log(`Image MD5 ${calcmd5}`);
      }
      const uncsize = image.length;
      let blocks;
      if (compress) {
        const uncimage = bstrToUi8(image);
        image = deflate(uncimage, { level: 9 });
        console.log("Compressed image ");
        console.log(image);
        blocks = await this.flashDeflBegin(uncsize, image.length, address);
      } else {
        blocks = await this.flashBegin(uncsize, address);
      }
      let seq = 0;
      let bytesSent = 0;
      const bytesWritten = 0;
      const totalBytes = image.length;
      if (reportProgress) reportProgress(i, 0, totalBytes);

      let d = new Date();
      const t1 = d.getTime();

      let timeout = 5000;
      while (image.length > 0) {
        console.log(`Write loop ${address} ${seq} ${blocks}`);
        console.log(
          `Writing at 0x${(address + seq * this.FLASH_WRITE_SIZE).toString(
            16
          )}... (${Math.floor((100 * (seq + 1)) / blocks)}%)`
        );
        const block = image.slice(0, this.FLASH_WRITE_SIZE) as Uint8Array; //TODO: no type assertion before
        if (compress) {
          /*
                    let blockUncompressed = inflate(block).length;
                    //let lenUncompressed = blockUncompressed.length;
                    bytesWritten += blockUncompressed;
                    if (this.timeoutPerMb(this.ERASE_WRITE_TIMEOUT_PER_MB, blockUncompressed) > 3000) {
                        blockTimeout = this.timeoutPerMb(this.ERASE_WRITE_TIMEOUT_PER_MB, blockUncompressed);
                    } else {
                        blockTimeout = 3000;
                    }*/ // XXX: Partial block inflate seems to be unsupported in Pako. Hardcoding timeout
          const blockTimeout = 5000;
          if (!this.IS_STUB) {
            timeout = blockTimeout;
          }
          await this.flashDeflBlock(block, seq, timeout);
          if (this.IS_STUB) {
            timeout = blockTimeout;
          }
        } else {
          throw new ESPError("Yet to handle Non Compressed writes");
        }
        bytesSent += block.length;
        image = image.slice(this.FLASH_WRITE_SIZE, image.length);
        seq++;
        if (reportProgress) reportProgress(i, bytesSent, totalBytes);
      }
      if (this.IS_STUB) {
        await this.readRegister(this.CHIP_DETECT_MAGIC_REG_ADDR, timeout);
      }
      d = new Date();
      const t = d.getTime() - t1;
      if (compress) {
        console.log(
          `Wrote ${uncsize} bytes (${bytesSent} compressed) at 0x${address.toString(
            16
          )} in ${t / 1000} seconds`
        );
      }
      if (calculateMD5Hash) {
        const res = await this.flashMd5Sum(address, uncsize);
        if (new String(res).valueOf() != new String(calcmd5).valueOf()) {
          console.log(`File  md5: ${calcmd5 ?? ""}`);
          console.log(`Flash md5: ${res}`);
          throw new ESPError("MD5 of file does not match data in flash!");
        } else {
          console.log("Hash of data verified.");
        }
      }
    }
    console.log("Leaving...");

    if (this.IS_STUB) {
      await this.flashBegin(0, 0);
      if (compress) {
        await this.flashDeflFinish(false);
      } else {
        await this.flashFinish(false);
      }
    }
  }

  public async hardReset() {
    await this.transport.setRTS(true); // EN->LOW
    await sleep(100);
    await this.transport.setRTS(false);
  }
}
