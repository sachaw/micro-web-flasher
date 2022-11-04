import { ESPLoader } from '../ESPLoader.js';

export abstract class BaseDevice {
  //should be abstract
  public abstract CHIP_NAME: string;
  public abstract IMAGE_CHIP_ID?: number;
  // public abstract EFUSE_RD_REG_BASE: number;
  // public abstract DR_REG_SYSCON_BASE: number;
  public abstract UART_CLKDIV_REG: number;
  public abstract UART_CLKDIV_MASK: number;
  public abstract UART_DATE_REG_ADDR?: number;
  // public abstract XTAL_CLK_DIVIDER: number;
  public abstract FLASH_WRITE_SIZE: number;
  public abstract BOOTLOADER_FLASH_OFFSET: number;
  public abstract FLASH_SIZES: Map<string, number>;
  public abstract SPI_REG_BASE: number;
  public abstract SPI_USR_OFFS: number;
  public abstract SPI_USR1_OFFS: number;
  public abstract SPI_USR2_OFFS: number;
  public abstract SPI_W0_OFFS: number;
  public abstract SPI_MOSI_DLEN_OFFS?: number;
  public abstract SPI_MISO_DLEN_OFFS?: number;
  public abstract TEXT_START: number;
  public abstract ENTRY: number;
  public abstract DATA_START: number;
  public abstract ROM_DATA: string;
  public abstract ROM_TEXT: string;

  public get_erase_size(offset: number, size: number) {
    return size;
  }

  public _d2h(d: number) {
    const h = (+d).toString(16);
    return h.length === 1 ? "0" + h : h;
  }

  public abstract getChipDescription(loader: ESPLoader): void;

  public abstract getChipFeatures(loader: ESPLoader): void;

  public abstract getCrystalFreq(loader: ESPLoader): void;

  public abstract readMac(loader: ESPLoader): Promise<string>;

  public abstract postConnect(loader: ESPLoader): void; //should be abstract

  // public abstract read_efuse(
  //   loader: ESPLoader,
  //   offset: number
  // ): Promise<number>;

  // public abstract get_pkg_version(loader: ESPLoader): void;
  // public abstract get_chip_revision(loader: ESPLoader): void;
}
