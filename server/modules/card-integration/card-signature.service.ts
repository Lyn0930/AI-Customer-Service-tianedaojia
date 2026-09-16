import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

const FEISHU_ENCRYPT_KEY = 'E0tnFuM9LdDuYYencITmmcKIvLxUjvpD';

/**
 * 飞书卡片回调签名验证服务
 *
 * 飞书卡片回调的签名算法：
 * 1. 将 timestamp、nonce、encryptKey、body 按字典序排序
 * 2. 拼接成字符串后计算 SHA1
 * 3. 与请求头中的 X-Lark-Signature 对比
 */
@Injectable()
export class CardSignatureService {
  private readonly logger = new Logger(CardSignatureService.name);
  private readonly encryptKey: string;

  constructor() {
    this.encryptKey = FEISHU_ENCRYPT_KEY;
  }

  /**
   * 校验签名是否有效
   * @param timestamp 请求头 X-Lark-Request-Timestamp
   * @param nonce 请求头 X-Lark-Request-Nonce
   * @param signature 请求头 X-Lark-Signature
   * @param body 请求体原始字符串
   */
  verify(timestamp: string, nonce: string, signature: string, body: string): boolean {
    const sorted = [timestamp, nonce, this.encryptKey, body].sort().join('');
    const computed = crypto.createHash('sha1').update(sorted).digest('hex');

    if (computed !== signature) {
      this.logger.warn(
        `签名校验失败：expected=${computed}, received=${signature}`,
      );
      return false;
    }

    return true;
  }

  /**
   * 是否已配置加密密钥
   */
  isConfigured(): boolean {
    return true;
  }
}
