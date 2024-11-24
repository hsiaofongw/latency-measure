import { Duplex } from "stream";
import { pipeline } from "stream/promises";

import {
  LatencyCalculator,
  PrettyPrintFormatter,
  SendTxTracker,
  SeqLogPass,
  TxLogPass,
  makeCounter,
} from "./latency";
import {
  pktSpec,
  PDUFromTx,
  PDUFromTimedBuffer,
  PacketFormulater,
} from "./pdu";
import { PacketParser } from "./packet";
import { TimerStream } from "./timer";

export class LatencyMeasurer {
  private rwStream: Duplex;
  private timerStream: TimerStream;
  private pduFromTx: PDUFromTx;
  private seqLogPass: SeqLogPass;
  private packetFomatter: PacketFormulater;
  private txLogPass: TxLogPass;
  private packetParser: PacketParser;
  private pduFromBuffer: PDUFromTimedBuffer;
  private latencyCalculator: LatencyCalculator;
  private formatter: PrettyPrintFormatter;

  constructor(intervalMs: number, rwStream: Duplex) {
    const counter = makeCounter();
    this.rwStream = rwStream;
    const txTracker = new SendTxTracker();

    this.timerStream = new TimerStream(intervalMs);
    this.pduFromTx = new PDUFromTx();
    this.seqLogPass = new SeqLogPass(counter);
    this.packetFomatter = new PacketFormulater();
    this.txLogPass = new TxLogPass(txTracker);
    this.packetParser = new PacketParser(pktSpec.totalSize, pktSpec.magicStr);
    this.pduFromBuffer = new PDUFromTimedBuffer(txTracker);
    this.latencyCalculator = new LatencyCalculator(txTracker);
    this.formatter = new PrettyPrintFormatter();
  }

  public start(): void {
    pipeline(
      this.timerStream, // 生成 tick 信号，timestamp（毫秒级时间戳）
      this.pduFromTx, // 从一个 timestamp 构建封包
      this.seqLogPass, // 填写 seqNum。
      this.packetFomatter, // 把 PDU 格式化成 Buffer（二进制）
      this.txLogPass, // 从 raw Buffer 读取 seqNum，把 seqNum 和时间关联，这一步应当离 TCP socket 最近。
      this.rwStream, // 实际负责数据流收发的 Duplex stream
      this.packetParser, // 封包解析完成后，第一时间记录接收时间（把解析时间记下来，透过 chunk object 传给下游）
      this.pduFromBuffer, // 从一块完整的封包 Buffer 构建封包，根据封包中的 seqNum, 以及 txTracker 以及 chunk object 中的 timestamp 更新 txTracker 中的值。
      this.latencyCalculator, // 从 txTracker 中读取精确往返时长和单程时长，生成一个 AnalyzeResult 传给下游。
      this.formatter, // 格式化 AnalyzeResult 为 utf8 编码的字符串二进制数据 (buffer)，传 buffer 给下游。
      process.stdout,
      {
        end: false,
      }
    ).catch((err) => {
      console.error("Error occured on pipeline:", err);
      process.exit(1);
    });
  }

  public stop() {
    this.timerStream.destroy();
  }
}